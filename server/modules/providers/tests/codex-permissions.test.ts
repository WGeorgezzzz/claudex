import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexPermissionBridge } from '@/modules/providers/list/codex/codex-permissions.provider.js';
import type { AnyRecord } from '@/shared/types.js';

test('Codex native approvals are routed once, scoped to the session and cancelled on turn end', () => {
  const bridge = new CodexPermissionBridge(); const events: AnyRecord[] = []; const replies: AnyRecord[] = [];
  assert.equal(bridge.request('a', { id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'echo test' } },
    { send: event => events.push(event as AnyRecord) }, result => replies.push(result)), true);
  assert.equal(replies.length, 0);
  assert.equal(bridge.listPending('b').length, 0);
  bridge.resolve(events[0].requestId, { allow: false }); bridge.resolve(events[0].requestId, { allow: true });
  assert.equal(replies.length, 1); assert.equal(replies[0].decision, 'decline');
  bridge.request('a', { id: 2, method: 'item/fileChange/requestApproval', params: {} }, { send: event => events.push(event as AnyRecord) }, result => replies.push(result));
  bridge.cancel('a', 2); assert.equal(bridge.listPending('a').length, 0);
  bridge.resolve(events[2].requestId, { allow: true }); assert.equal(replies.length, 1);
});

test('Codex questions map display answers back to native question IDs', () => {
  const bridge = new CodexPermissionBridge(); let event: AnyRecord = {}; let reply;
  bridge.request('a', { id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue' }] }] } },
    { send: value => { if ((value as AnyRecord).kind === 'permission_request') event = value as AnyRecord; } }, result => { reply = result; });
  assert.equal(event.toolName, 'AskUserQuestion');
  bridge.resolve(event.requestId, { allow: true, updatedInput: { answers: { 'Which color?': 'Blue' } } });
  assert.deepEqual(reply, { answers: { color: { answers: ['Blue'] } } });
});
