import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { installAuthorizationFixture, testUserId } from '@/test-support/authorization-fixture.js';
import { sessionsDb, messageQueueDb, getConnection } from '@/modules/database/index.js';

import { recoverProviderSupervision } from '../services/provider-supervision-controller.service.js';

installAuthorizationFixture();
function fixture(metadata: Record<string, unknown>, complete = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-recovery-'));
  process.env.CLOUDCLI_HOME = root;
  const sessionId = 'recovery-' + randomUUID();
  sessionsDb.createAppSession(sessionId, 'codex', root);
  const id = randomUUID(), directory = path.join(root, 'supervised-turns', id);
  fs.mkdirSync(directory, { recursive: true });
  const options = { sessionId, permissionMode: 'plan', allowedTools: ['Read'], disallowedTools: ['Bash'] };
  fs.writeFileSync(path.join(directory, 'launch.json'), JSON.stringify({ mode: 'runtime', provider: 'codex', userId: testUserId(), options }));
  fs.writeFileSync(path.join(directory, 'token'), 'test-only-unreachable-endpoint');
  fs.writeFileSync(path.join(directory, 'registry.json'), JSON.stringify({ version: 1, id, pid: 2147483647, port: 1, state: complete ? 'exited' : 'running', startedAt: new Date().toISOString(), metadata }));
  fs.writeFileSync(path.join(directory, 'output.ndjson'), complete ? JSON.stringify({ seq: 1, kind: 'message', data: { kind: 'complete', exitCode: 0 } })+'\n'+JSON.stringify({ seq: 2, kind: 'exit', data: { code: 0 } })+'\n' : '');
  return { root, sessionId, directory, options };
}

test('only a failed formerly-running user turn gets one idempotent continuation, without privilege increase; original attempt retained', async () => {
  const input = fixture({ formerlyRunning: true, userTurn: true });
  const queued = messageQueueDb.create(testUserId(), input.sessionId, randomUUID(), 'test', 'original work', JSON.stringify(input.options));
  const claimed = messageQueueDb.claim(queued.id)!;
  fs.writeFileSync(path.join(input.directory, 'launch.json'), JSON.stringify({ mode: 'runtime', provider: 'codex', userId: testUserId(), options: { ...input.options, cloudcliQueueAttempt: claimed } }));
  await recoverProviderSupervision();
  await recoverProviderSupervision();
  const rows = messageQueueDb.list(testUserId(), input.sessionId);
  const continuations = rows.filter(row => row.content === '服务已重启，继续上一步');
  assert.equal(continuations.length, 1);
  assert.equal(JSON.parse(continuations[0].options).permissionMode, 'plan');
  assert.deepEqual(JSON.parse(continuations[0].options).disallowedTools, ['Bash']);
  assert.equal(messageQueueDb.get(testUserId(), queued.id)?.status, 'interrupted');
  assert.equal(messageQueueDb.attempts(testUserId(), queued.id)[0].status, 'interrupted');
  assert.equal((getConnection().prepare('SELECT recovered_by FROM message_queue WHERE id=?').get(queued.id) as { recovered_by: string }).recovered_by, continuations[0].id);
  assert.ok(messageQueueDb.heads().some(row => row.id === continuations[0].id), 'Linked interrupted head must not block its continuation');
});

for (const [name, metadata, complete] of [
  ['never started', { formerlyRunning: false, userTurn: true }, false],
  ['autonomous monitor', { formerlyRunning: true, userTurn: false }, false],
  ['already completed', { formerlyRunning: true, userTurn: true, foregroundCompleted: true }, true],
] as const) test(name + ' is never automatically continued', async () => {
  const input = fixture(metadata, complete);
  await recoverProviderSupervision();
  await recoverProviderSupervision();
  assert.equal(messageQueueDb.list(testUserId(), input.sessionId).length, 0);
});

test('queue recovery preserves adopted attempts and interrupts unrelated uncertain attempts', () => {
  const a = fixture({}), b = fixture({});
  const q1 = messageQueueDb.create(testUserId(), a.sessionId, randomUUID(), 'test', 'adopted', '{}');
  const q2 = messageQueueDb.create(testUserId(), b.sessionId, randomUUID(), 'test', 'lost', '{}');
  messageQueueDb.claim(q1.id); messageQueueDb.claim(q2.id);
  messageQueueDb.recover([a.sessionId]);
  assert.equal(messageQueueDb.get(testUserId(), q1.id)?.status, 'running');
  assert.equal(messageQueueDb.attempts(testUserId(), q1.id)[0].status, 'running');
  assert.equal(messageQueueDb.get(testUserId(), q2.id)?.status, 'interrupted');
  assert.equal(messageQueueDb.attempts(testUserId(), q2.id)[0].status, 'interrupted');
});
