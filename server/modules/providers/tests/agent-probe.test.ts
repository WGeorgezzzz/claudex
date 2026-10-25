import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { probeAgent, countAgentSessions, readAgentVersion } from '../services/agent-probe.js';

test('Windows PATH honors exe/cmd/ps1 and newest native Codex version directory', async () => {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\tools\\qwen.ps1', 'C:\\local\\OpenAI\\Codex\\bin\\0.156.1\\codex.exe', 'C:\\local\\OpenAI\\Codex\\bin\\0.99.0\\codex.exe']);
  const base = { platform: 'win32' as const, home: 'C:\\user', env: { PATH: 'C:\\npm;C:\\tools', LOCALAPPDATA: 'C:\\local' }, exists: async (file: string) => files.has(file), list: async () => ['0.99.0', '0.156.1'], version: async () => '0.156.1' };
  assert.equal((await probeAgent(['claude'], base))?.executable, 'C:\\npm\\claude.cmd');
  assert.equal((await probeAgent(['qwen'], base))?.executable, 'C:\\tools\\qwen.ps1');
  assert.match((await probeAgent(['codex'], base))!.executable, /0\.156\.1/);
});
test('macOS Homebrew and Linux user installs resolve without PATH; missing or unsuccessful version stays absent', async () => {
  for (const [platform, file] of [['darwin', '/opt/homebrew/bin/aider'], ['linux', '/home/test/.local/bin/aider']] as const) {
    const options = { platform, home: '/home/test', env: {}, exists: async (candidate: string) => candidate === file, version: async () => '1.0' };
    assert.equal((await probeAgent(['aider'], options))?.executable, file);
    assert.equal(await probeAgent(['missing'], options), null);
    assert.equal(await probeAgent(['aider'], { ...options, version: async () => null }), null);
  }
});
test('native Codex hash directories use install time, and newly installed CLI is discovered without restarting', async () => {
  const files = new Set<string>();
  const base = { platform: 'win32' as const, home: 'C:\\user', env: { LOCALAPPDATA: 'C:\\local' },
    list: async () => ['aaaa-old-hash', '0000-new-hash'], modified: async (file: string) => file.endsWith('0000-new-hash') ? 200 : 100,
    exists: async (file: string) => files.has(file), version: async () => 'codex-cli 1.2.3' };
  assert.equal(await probeAgent(['codex'], base), null);
  files.add('C:\\local\\OpenAI\\Codex\\bin\\aaaa-old-hash\\codex.exe');
  files.add('C:\\local\\OpenAI\\Codex\\bin\\0000-new-hash\\codex.exe');
  assert.match((await probeAgent(['codex'], base))!.executable, /0000-new-hash/);
});
test('version probe reports success, nonzero/ENOENT and kills a real timeout at five seconds', async () => {
  assert.match((await readAgentVersion(process.execPath))!, /^v\d/);
  assert.equal(await readAgentVersion(path.join(os.tmpdir(), 'nexagent-no-such-program.exe')), null);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-probe-'));
  try {
    const file = path.join(dir, process.platform === 'win32' ? 'hang.ps1' : 'hang');
    await fs.writeFile(file, process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : '#!/bin/sh\nsleep 30\n', { mode: 0o700 });
    const started = Date.now(); assert.equal(await readAgentVersion(file), null);
    assert(Date.now() - started >= 4900 && Date.now() - started < 10000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('session scan counts file names without reading malformed transcript content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-count-'));
  try {
    await fs.mkdir(path.join(dir, 'project'));
    await fs.writeFile(path.join(dir, 'project', 'session.jsonl'), 'not readable JSON');
    await fs.writeFile(path.join(dir, 'project', 'store.db'), 'not a database');
    await fs.writeFile(path.join(dir, 'credentials.txt'), 'not a session');
    await fs.writeFile(path.join(dir, 'project', 'sessions-index.json'), 'not a transcript');
    assert.equal(await countAgentSessions(dir), 2);
    assert.equal(await countAgentSessions(path.join(dir, 'absent')), 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('modern OpenCode uses a read-only session count without loading messages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-opencode-count-'));
  const file = path.join(dir, 'opencode.db');
  const database = new Database(file);
  database.exec("CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES ('first'),('second')");
  database.close();
  try { assert.equal(await countAgentSessions(path.join(dir, 'legacy'), file), 2); }
  finally { await fs.rm(dir, {recursive:true,force:true}); }
});
