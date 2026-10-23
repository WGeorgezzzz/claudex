import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';

test('Claude uses connected account wire IDs, deduplicates aliases and preserves reported effort', async () => {
  const adapter = new ClaudeProviderModels(async () => [
    { value: 'default', resolvedModel: 'vendor-opus-7', displayName: 'Default', description: '', supportedEffortLevels: ['low', 'high'] },
    { value: 'opus', resolvedModel: 'vendor-opus-7', displayName: 'Vendor Opus 7', description: '', supportedEffortLevels: ['low', 'high'] },
    { value: 'private-model', displayName: 'Private Model', description: '' },
  ]);
  const catalog = await adapter.getSupportedModels();
  assert.deepEqual(catalog.OPTIONS.map(m => m.value), ['vendor-opus-7', 'private-model']);
  assert.equal(catalog.DEFAULT, 'vendor-opus-7');
  assert.deepEqual(catalog.OPTIONS[0].effort?.values.map(e => e.value), ['low', 'high']);
  assert.equal(catalog.OPTIONS[1].effort, undefined);
  assert.equal(catalog.OPTIONS[0].label, 'vendor-opus-7');
});

test('Claude discovery failure never substitutes a shipped model list', async () => {
  const adapter = new ClaudeProviderModels(async () => { throw new Error('offline'); });
  await assert.rejects(adapter.getSupportedModels(), /offline/);
});

test('Claude empty account catalog never substitutes guessed models', async () => {
  await assert.rejects(new ClaudeProviderModels(async () => []).getSupportedModels(), /models/i);
});

test('Codex uses the account catalog and hides internal models while preserving exact IDs and effort', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claudex-model-test-'));
  try {
    await writeFile(path.join(home, 'config.toml'), 'model = "account-model-9"');
    await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'account-model-9', display_name: 'Friendly Name', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
      { slug: 'internal', visibility: 'hide' },
    ] }));
    const catalog = await new CodexProviderModels(home).getSupportedModels();
    assert.deepEqual(catalog.OPTIONS.map(m => m.value), ['account-model-9']);
    assert.equal(catalog.OPTIONS[0].label, 'account-model-9');
    assert.equal(catalog.DEFAULT, 'account-model-9');
    assert.deepEqual(catalog.OPTIONS[0].effort?.values, [{ value: 'high' }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Codex gateway catalog is authenticated and never mixes the official account cache', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claudex-model-test-'));
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer fixture-key') {
      res.writeHead(401).end(); return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gateway-model' }] }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(path.join(home, 'config.toml'), `model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "http://127.0.0.1:${address.port}/v1"`);
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }));
    await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'unrelated-model' }] }));
    assert.deepEqual((await new CodexProviderModels(home).getSupportedModels()).OPTIONS.map(m => m.value), ['gateway-model']);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
