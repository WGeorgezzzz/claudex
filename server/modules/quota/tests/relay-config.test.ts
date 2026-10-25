import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeRelayBaseUrl, readRelayConfiguration, saveRelayConfiguration, readLegacyRelayBaseUrl } from '../quota.config.js';
import { createQuotaService } from '../quota.service.js';

test('relay configuration persists, honors environment and rejects credential-bearing or insecure URLs', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-config-'));
  const home = process.env.CLOUDCLI_HOME, override = process.env.NEXAGENT_RELAY_BASE_URL;
  process.env.CLOUDCLI_HOME = directory; delete process.env.NEXAGENT_RELAY_BASE_URL;
  try {
    assert.equal(readRelayConfiguration().baseUrl, '');
    assert.equal(saveRelayConfiguration('https://relay.example.com/').baseUrl, 'https://relay.example.com');
    assert.equal(readRelayConfiguration().baseUrl, 'https://relay.example.com');
    writeFileSync(path.join(directory, 'relay.json'), JSON.stringify({ baseUrl: 'https://relay.example.com', legacyBaseUrl: 'https://original.example.com' }));
    saveRelayConfiguration('https://new.example.com');
    assert.equal(readLegacyRelayBaseUrl(), 'https://original.example.com');
    process.env.NEXAGENT_RELAY_BASE_URL = 'https://another.example.com';
    assert.equal(readRelayConfiguration().source, 'environment');
    assert.equal(readRelayConfiguration().baseUrl, 'https://another.example.com');
    assert.equal(readLegacyRelayBaseUrl(), 'https://original.example.com');
    assert.throws(() => saveRelayConfiguration(''));
    for (const url of ['http://relay.example.com', 'https://user:password@example.com', 'https://relay.example.com?key=secret', 'file:///tmp/a']) assert.throws(() => normalizeRelayBaseUrl(url));
    assert.equal(normalizeRelayBaseUrl('http://127.0.0.1:1234/'), 'http://127.0.0.1:1234');
  } finally {
    if (home === undefined) delete process.env.CLOUDCLI_HOME; else process.env.CLOUDCLI_HOME = home;
    if (override === undefined) delete process.env.NEXAGENT_RELAY_BASE_URL; else process.env.NEXAGENT_RELAY_BASE_URL = override;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unconfigured relay is neutral and never reads or sends relay credentials', async () => {
  let calls = 0;
  const service = createQuotaService({ secretFile: '/secret',
    readJson: async () => { throw Error('No subscription'); },
    paths: () => ({ adminClaude: '/claude', adminCodex: '/codex', configRoot: '/users', root: '/users/1', claudeConfigDir: '/claude', codexHome: '/codex' }),
    db: () => { throw Error('Must not write'); }, password: async () => { throw Error('Must not login'); },
    request: async () => { calls++; throw Error('Must not request'); },
  });
  const result = await service.overview({ userId: 1, role: 'admin' });
  assert.equal(result.key.data?.mode, 'unconfigured'); assert.equal(result.key.error, null);
  assert.equal(result.pool?.error, null); await service.refreshPool(); assert.equal(calls, 0);
});

test('changing the relay destination cannot forward another relay administrator key', async () => {
  let calls = 0;
  const service = createQuotaService({ relayBaseUrl: 'https://new.example.com', secretFile: '/secret',
    readJson: async () => ({ baseUrl: 'https://old.example.com', apiKey: 'fixture-key' }),
    paths: () => ({ adminClaude: '/claude', adminCodex: '/codex', configRoot: '/users', root: '/users/1', claudeConfigDir: '/claude', codexHome: '/codex' }),
    db: () => { throw Error('Must not write'); }, password: async () => '',
    request: async () => { calls++; throw Error('Must not request'); },
  });
  assert.match((await service.refreshPool()).error ?? '', /未绑定/); assert.equal(calls, 0);
});
