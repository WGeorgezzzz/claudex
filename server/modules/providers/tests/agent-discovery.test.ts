import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAuthorizationFixture } from '@/test-support/authorization-fixture.js';
import { agentDiscoveryService } from '../services/agent-discovery.service.js';
import { providerRegistry } from '../provider.registry.js';
import { appConfigDb } from '@/modules/database/index.js';
import { userContextStorage } from '@/shared/index.js';

installAuthorizationFixture();
test('installed/authenticated auto-enables; logged-out/missing stays disabled; member projection hides host paths and unsupported providers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-discovery-'));
  const oldPath = process.env.PATH;
  const auth = providerRegistry.resolveProvider('claude').auth;
  const original = auth.getStatus;
  let loggedIn = true;
  try {
    const command = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    await fs.writeFile(command, process.platform === 'win32' ? '@echo off\r\necho Claude-fixture 1.2.3\r\n' : '#!/bin/sh\necho Claude-fixture 1.2.3\n', { mode: 0o700 });
    process.env.PATH = dir + path.delimiter + (oldPath ?? '');
    auth.getStatus = async () => ({ installed: true, authenticated: loggedIn, provider: 'claude', email: 'do-not-project@example.test', method: 'fixture' });
    const context = (userId: number, role: 'admin' | 'member') => ({ userId, role, workRoot: dir, allowedFolders: [], claudeConfigDir: path.join(dir, '.claude'), codexHome: path.join(dir, '.codex'), env: {} });
    const admin = await userContextStorage.run(context(1, 'admin'), () => agentDiscoveryService.scan(true)) as {agents: Array<Record<string, unknown>>};
    assert(admin.agents.some(a => a.id === 'claude' && a.enabled === true && String(a.version).includes('1.2.3')));
    assert(admin.agents.some(a => a.id === 'gemini' && a.supported === false && a.enabled === false));
    loggedIn = false;
    const loggedOut = await userContextStorage.run(context(1, 'admin'), () => agentDiscoveryService.scan()) as typeof admin;
    assert.equal(loggedOut.agents.find(a => a.id === 'claude')!.enabled, false);
    loggedIn = true;
    const member = await userContextStorage.run(context(2, 'member'), () => agentDiscoveryService.scan()) as typeof admin;
    assert(member.agents.every(a => ['claude', 'codex'].includes(String(a.id))));
    assert(!/executable|configDirectory|sessionCount|do-not-project|nexagent-discovery-/.test(JSON.stringify(member)));
    assert(appConfigDb.get('agent-discovery:user:1')); assert(appConfigDb.get('agent-discovery:user:2'));
    userContextStorage.run(context(1, 'admin'), () => agentDiscoveryService.setEnabled('claude', false));
    const disabled = await userContextStorage.run(context(2, 'member'), () => agentDiscoveryService.read()) as typeof admin;
    assert.equal(disabled.agents.find(a => a.id === 'claude')!.enabled, false);
    assert.throws(() => userContextStorage.run(context(2, 'member'), () => agentDiscoveryService.setEnabled('claude', true)), /Administrator/);
    assert.throws(() => userContextStorage.run(context(2, 'member'), () => agentDiscoveryService.assertEnabled('claude')), /disabled/);
    userContextStorage.run(context(1, 'admin'), () => agentDiscoveryService.setEnabled('claude', true));
  } finally {
    auth.getStatus = original; process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
