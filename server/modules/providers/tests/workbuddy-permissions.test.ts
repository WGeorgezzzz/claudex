import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkBuddyPermissionBridge } from '@/modules/providers/list/workbuddy/workbuddy-permissions.provider.js';
import { WorkBuddySessionsProvider } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/index.js';

test('WorkBuddy approval IDs isolate concurrent runs with identical native request IDs', () => {
  const bridge = new WorkBuddyPermissionBridge();
  const events: NormalizedMessage[] = [];
  const replies: unknown[][] = [[], []];
  const writer = { send: (event: unknown) => events.push(event as NormalizedMessage) };
  const row = { request_id: 'perm_1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'proof.txt' }, tool_use_id: 'call_1' } };
  bridge.request('one', row, writer, value => replies[0].push(value));
  bridge.request('two', row, writer, value => replies[1].push(value));
  const id = bridge.listPending('one')[0].requestId!;
  assert.notEqual(id, bridge.listPending('two')[0].requestId);
  bridge.resolve(id, { allow: false, message: 'No write' });
  assert.deepEqual(replies[0], [{ type: 'control_response', response: { subtype: 'success', request_id: 'perm_1',
    response: { allowed: false, updatedInput: { file_path: 'proof.txt' }, reason: 'No write' } } }]);
  assert.equal(replies[1].length, 0);
  assert.equal(bridge.listPending('one').length, 0);
  assert.equal(bridge.listPending('two').length, 1);
  bridge.resolve(id, { allow: true });
  assert.equal(replies[0].length, 1, 'a resolved request cannot execute twice');
  bridge.cancel('two');
  assert.equal(bridge.listPending('two').length, 0);
  assert.equal(events.at(-1)?.kind, 'permission_cancelled');
});

test('WorkBuddy passes edited approval input and rejects unsupported control requests', () => {
  const bridge = new WorkBuddyPermissionBridge(), replies: unknown[] = [];
  bridge.request('one', { request_id: 'perm_1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } }, { send() {} }, value => replies.push(value));
  bridge.resolve(bridge.listPending('one')[0].requestId!, { allow: true, updatedInput: { answer: 'chosen' } });
  assert.deepEqual((replies[0] as { response: { response: unknown } }).response.response,
    { allowed: true, updatedInput: { answer: 'chosen' }, reason: 'Approved by user' });
  bridge.request('one', { request_id: 'unknown', request: { subtype: 'unknown' } }, { send() {} }, value => replies.push(value));
  assert.equal((replies[1] as { response: { subtype: string } }).response.subtype, 'error');
});

test('WorkBuddy preserves tool calls and error results in live events and history', () => {
  const adapter = new WorkBuddySessionsProvider();
  const [call] = adapter.normalizeMessage({ type: 'assistant', uuid: 'a', message: { model: 'hy3', content: [
    { type: 'tool_use', id: 'call_1', name: 'Write', input: { file_path: 'proof.txt' } },
  ] } }, 'session');
  assert.equal(call.kind, 'tool_use'); assert.equal(call.toolId, 'call_1'); assert.equal(call.model, 'hy3');
  const [result] = adapter.normalizeMessage({ type: 'user', uuid: 'b', message: { content: [
    { type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: [{ type: 'text', text: 'Denied' }] },
  ] } }, 'session');
  assert.equal(result.kind, 'tool_result'); assert.equal(result.toolId, call.toolId);
  assert.equal(result.content, 'Denied', 'the transcript UI reads the result content from the normalized envelope');
  assert.deepEqual(result.toolResult, { content: 'Denied', isError: true });
});
