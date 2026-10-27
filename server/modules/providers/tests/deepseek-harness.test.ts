import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeepSeekHarnessSessions, deepSeekHarnessTranscriptPath } from '@/modules/providers/list/deepseek-harness/deepseek-harness-sessions.provider.js';
import { resolveDeepSeekHarnessInstallation } from '@/modules/providers/list/deepseek-harness/deepseek-harness-installation.provider.js';
import { userContextStorage } from '@/shared/utils.js';
import type { UserRuntimeContext } from '@/shared/types.js';

test('Harness tool errors keep correlation, output and failure state', () => {
  const parser = new DeepSeekHarnessSessions();
  const [call] = parser.normalizeMessage({ type: 'tool_call', uuid: 'c1', callId: 'native1', tool: 'write', input: { file_path: 'proof.txt' } }, 'app1');
  const [result] = parser.normalizeMessage({ type: 'tool_result', uuid: 'r1', callId: 'native1', status: 'error', result: 'permission denied' }, 'app1');
  assert.equal(call.kind, 'tool_use'); assert.equal(call.toolName, 'write');
  assert.equal(result.toolId, call.toolId); assert.equal(result.isError, true);
  assert.equal(result.content, 'permission denied');
});

test('Harness final markers do not duplicate assistant text and native diagnostics are not prose', () => {
  const parser = new DeepSeekHarnessSessions();
  assert.equal(parser.normalizeMessage({ type: 'text', text: 'answer' }, 'app1').length, 1);
  assert.deepEqual(parser.normalizeMessage({ type: 'final', text: 'answer' }, 'app1'), []);
  assert.deepEqual(parser.normalizeMessage({ type: 'status', phase: 'turn_end', reason: { kind: 'failed' } }, 'app1'), []);
  assert.equal(parser.normalizeMessage({ type: 'nexagent_error', text: 'model unavailable' }, 'app1')[0].kind, 'error');
});

test('Harness transcript IDs reject filesystem traversal', () => {
  for (const id of ['', '../credential', 'x/y', 'x\\y', 'x'.repeat(121)]) assert.throws(() => deepSeekHarnessTranscriptPath(id));
});

test('Harness local credentials are not exposed to ordinary members', () => {
  userContextStorage.run({ role: 'member' } as UserRuntimeContext, () => assert.equal(resolveDeepSeekHarnessInstallation(), null));
});

test('Harness history follows the stable app id across native resume and retains errors in tail pagination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-history-test-'));
  const previous = process.env.CLOUDCLI_HOME;
  process.env.CLOUDCLI_HOME = directory;
  try {
    const file = deepSeekHarnessTranscriptPath('stable-app');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      { type: 'user', uuid: 'u1', text: 'first question' },
      { type: 'text', uuid: 'a1', text: 'first answer' },
      { type: 'final', text: 'first answer' },
      { type: 'nexagent_error', uuid: 'e1', text: 'upstream failed' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await new DeepSeekHarnessSessions().fetchHistory('stable-app', { providerSessionId: 'different-native-id', limit: 1 });
    assert.equal(result.total, 3); assert.equal(result.hasMore, true);
    assert.equal(result.messages[0].kind, 'error'); assert.equal(result.messages[0].sessionId, 'stable-app');
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_HOME; else process.env.CLOUDCLI_HOME = previous;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('harness-history-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
