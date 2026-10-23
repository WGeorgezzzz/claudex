import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { userContextStorage } from '@/shared/utils.js';
import { resolveWorkBuddyInstallation } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import { WorkBuddySessionsProvider, workBuddyTranscriptPath } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { UserRuntimeContext } from '@/shared/types.js';
import { buildWorkBuddyFreeModels } from '@/modules/providers/list/workbuddy/workbuddy-models.provider.js';
import { workBuddyRuntime } from '@/modules/providers/list/workbuddy/workbuddy-runtime.provider.js';

test('WorkBuddy lists only explicitly zero-credit chat models and prefers DeepSeek', () => {
  const model = (id: string, credits?: unknown, extra = {}) => ({ id, name: id, credits, supportsToolCall: true, ...extra });
  const catalog = buildWorkBuddyFreeModels({ models: [
    model('hy3', 'x0.00 credits'), model('fast-model', 'x0.34 credits'),
    model('deepseek-v4.1-flash-sg', 'x0.03 credits'), model('unknown'),
    model('promo-label', 'Free now'), model('rounded-price', 'x0.001'),
    model('numeric-zero', 0), model('disabled', 'x0', { disabled: true }),
    model('not-enabled', 'x0', { enabled: false }), model('image-only', 'x0', { supportsToolCall: false }),
    model('deepseek-v4.1-flash', 'x0.00 credits'), model('hy3', 'x0'), null,
  ] });
  assert.deepEqual(catalog.OPTIONS.map(option => option.value), ['deepseek-v4.1-flash', 'hy3']);
  assert.equal(catalog.DEFAULT, 'deepseek-v4.1-flash');
});

test('WorkBuddy never invents a free fallback when prices are absent or become nonzero', () => {
  for (const product of [null, {}, { models: 'invalid' }, { models: [{ id: 'hy3', credits: 'x0.01', supportsToolCall: true }] }]) {
    assert.deepEqual(buildWorkBuddyFreeModels(product), { OPTIONS: [], DEFAULT: '' });
  }
});

test('WorkBuddy includes remotely added Step 5 only inside its free promotion window', () => {
  const catalog = { models: [{ id: 'step-5-preview', name: 'Step 5', credits: 'x0.00', supportsToolCall: true }], modelPromotions: [
    { enabled: true, modelIds: ['step-5-preview'], discount: { factor: 0 }, schedule: { validFrom: '2026-10-12T00:00:00+08:00', validUntil: '2026-10-26T00:00:00+08:00' } },
  ] };
  assert.equal(buildWorkBuddyFreeModels(catalog, Date.parse('2026-10-24T12:00:00+08:00')).DEFAULT, 'step-5-preview');
  assert.equal(buildWorkBuddyFreeModels(catalog, Date.parse('2026-10-26T00:00:00+08:00')).OPTIONS.length, 0);
  assert.equal(buildWorkBuddyFreeModels(catalog, Date.parse('2026-10-11T23:59:59+08:00')).OPTIONS.length, 0);
});

test('WorkBuddy blocks a paid saved selection before spawning a process or saving a prompt', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claudex-workbuddy-test-'));
  const previous = process.env.WORKBUDDY_INSTALL_DIR;
  process.env.WORKBUDDY_INSTALL_DIR = root;
  try {
    await mkdir(path.join(root, 'resources/app.asar.unpacked/cli/dist'), { recursive: true });
    await writeFile(path.join(root, 'WorkBuddyAI.exe'), 'not an executable');
    await writeFile(path.join(root, 'resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'), '');
    await writeFile(path.join(root, 'resources/app.asar.unpacked/cli/product.json'), JSON.stringify({ models: [
      { id: 'free', credits: 'x0', supportsToolCall: true },
    ] }));
    await assert.rejects(workBuddyRuntime.run('must not send', {}, { send: event => assert.equal((event as { kind: string }).kind, 'error') }, {
      resolveProviderSessionId: () => assert.fail('must validate before creating transcript'),
      resolveResumeModel: async () => 'fast-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    }), /仅允许免费模型/);
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_INSTALL_DIR;
    else process.env.WORKBUDDY_INSTALL_DIR = previous;
    assert(root.startsWith(path.join(os.tmpdir(), 'claudex-workbuddy-test-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('WorkBuddy preserves actual provider, model, role and durable row identity', () => {
  const adapter = new WorkBuddySessionsProvider();
  const messages = adapter.normalizeMessage({ type: 'assistant', uuid: 'native-row', message: { model: 'fast-model', content: [{ type: 'text', text: 'Hello' }] } }, 'app-id');
  assert.equal(messages[0].provider, 'workbuddy');
  assert.equal(messages[0].model, 'fast-model');
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].id, 'native-row-0');
  assert.equal(messages[0].content, 'Hello');
  assert.deepEqual(adapter.normalizeMessage({ type: 'system', apiKeySource: 'secret' }, 'app-id'), []);
});

test('WorkBuddy failures remain failures in saved history', () => {
  const adapter = new WorkBuddySessionsProvider();
  const [error] = adapter.normalizeMessage({ type: 'claudex_error', uuid: 'failure', content: 'model is not allowed' }, 'app-id');
  assert.equal(error.kind, 'error');
  assert.equal(error.content, 'model is not allowed');
  assert.equal(error.provider, 'workbuddy');
});

test('WorkBuddy transcript IDs cannot traverse outside their directory', () => {
  for (const id of ['../auth', 'x/y', 'x\\y', '', 'x'.repeat(121)]) assert.throws(() => workBuddyTranscriptPath(id));
});

test('WorkBuddy shared desktop login is unavailable to ordinary members', () => {
  userContextStorage.run({ role: 'member' } as UserRuntimeContext, () => assert.equal(resolveWorkBuddyInstallation(), null));
});

test('WorkBuddy history uses the app id and preserves pagination across native session mapping', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claudex-workbuddy-test-'));
  const previous = process.env.CLOUDCLI_HOME;
  process.env.CLOUDCLI_HOME = root;
  try {
    const file = workBuddyTranscriptPath('app-id');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'question' }] } },
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'answer' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const page = await new WorkBuddySessionsProvider().fetchHistory('app-id', { providerSessionId: 'native-id', limit: 1 });
    assert.equal(page.total, 2); assert.equal(page.hasMore, true); assert.equal(page.messages[0].content, 'answer');
    assert.equal(page.messages[0].sessionId, 'app-id');
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_HOME; else process.env.CLOUDCLI_HOME = previous;
    assert(root.startsWith(path.join(os.tmpdir(), 'claudex-workbuddy-test-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('WorkBuddy exposes only capabilities implemented by the conversation adapter', () => {
  const caps = providerCapabilitiesService.getProviderCapabilities('workbuddy');
  assert.equal(caps.supportsAbort, true);
  assert.equal(caps.supportsImages, false);
  assert.equal(caps.supportsFiles, false);
  assert.equal(caps.supportsPermissionRequests, true);
  assert.equal(caps.supportsSessionForking, false);
  assert.deepEqual(caps.permissionModes, ['default', 'acceptEdits', 'bypassPermissions', 'plan']);
});
