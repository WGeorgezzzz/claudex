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
  assert.equal(caps.supportsPermissionRequests, false);
  assert.equal(caps.supportsSessionForking, false);
  assert.deepEqual(caps.permissionModes, ['default']);
});
