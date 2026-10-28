import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { installAuthorizationFixture, testUserId } from '@/test-support/authorization-fixture.js';
import { getConnection, projectsDb, userDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import { chatRunRegistry, connectedClients, clientUserIds } from '@/modules/websocket/index.js';
import { withUserContext } from '@/modules/auth/index.js';
import { taskmasterAutoService, taskmasterWorkspace } from '../taskmaster-auto.service.js';
import { sessionsService, providerRuntimeService } from '@/modules/providers/index.js';
import { createTaskmasterNativeRouter } from '../taskmaster-native.routes.js';

installAuthorizationFixture();
test('native HTTP initialization, validation, account/project isolation and junction boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexagent-native-http-')), own = path.join(root, 'member'), other = path.join(root, 'other');
  await mkdir(own); await mkdir(other);
  const member = Number(userDb.createUser('native-member', 'unused').id);
  getConnection().prepare("UPDATE users SET role='member',work_root=? WHERE id=?").run(own, member);
  let ownId = '', otherId = '';
  withUserContext(member, () => { projectsDb.createProjectPath(own, 'Own'); ownId = projectsDb.getProjectPath(own)!.project_id; sessionsDb.createAppSession('native-own-session', 'claude', own, 'Own'); });
  withUserContext(testUserId(), () => { projectsDb.createProjectPath(other, 'Other'); otherId = projectsDb.getProjectPath(other)!.project_id; sessionsDb.createAppSession('native-other-session', 'claude', other, 'Other'); });
  const ownClient = { readyState: 1, frames: [] as string[], send(value: string) { this.frames.push(value); } };
  const otherClient = { readyState: 1, frames: [] as string[], send(value: string) { this.frames.push(value); } };
  connectedClients.add(ownClient); connectedClients.add(otherClient); clientUserIds.set(ownClient, member); clientUserIds.set(otherClient, testUserId());
  let actor: number | null = member;
  const app = express().use(express.json()).use((req, _res, next) => { if (actor) (req as typeof req & { user: { id: number } }).user = { id: actor }; next(); }).use('/api/taskmaster', createTaskmasterNativeRouter());
  app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode ?? 500).json({ message: error.message }); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/taskmaster`;
  const request = (url: string, method = 'GET', data?: unknown) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  try {
    assert.equal((await request('/inbox/global')).status, 403);
    assert.equal((await request('/inbox/import', 'POST', { batchId: 'member', items: [] })).status, 403);
    assert.equal((await request(`/init/${ownId}`, 'POST')).status, 200);
    assert.equal((await request(`/init/${ownId}`, 'POST')).status, 200);
    assert.equal((await request(`/add-task/${ownId}`, 'POST', { title: '成员任务', description: '保留' })).status, 200);
    assert.equal((await request(`/update-task/${ownId}/1`, 'PUT', { status: 'done' })).status, 200);
    assert.equal((await request(`/update-task/${ownId}/1`, 'PUT', { status: 'invented' })).status, 400);
    assert.equal((await request(`/tasks/${otherId}`)).status, 404);
    assert(ownClient.frames.some(frame => JSON.parse(frame).type === 'taskmaster-tasks-updated')); assert.equal(otherClient.frames.length, 0);
    assert.equal((await request('/auto/sessions/native-other-session')).status, 403);
    assert.equal((await request('/auto/settings', 'PUT', { enabled: false, suggestOnly: true, disabledProjects: [] })).status, 200);
    assert.equal(((await (await request('/auto/settings')).json()) as { enabled: boolean }).enabled, false);
    actor = null; assert.equal((await request('/auto/settings')).status, 401); actor = member;
    const escape = path.join(own, 'escape'); await mkdir(escape); const target = path.join(other, '.taskmaster'); await mkdir(target);
    await symlink(target, path.join(escape, '.taskmaster'), 'junction');
    let escapeId = ''; withUserContext(member, () => { projectsDb.createProjectPath(escape, 'Escape'); escapeId = projectsDb.getProjectPath(escape)!.project_id; });
    assert.equal((await request(`/init/${escapeId}`, 'POST')).status, 403);
  } finally { connectedClients.delete(ownClient); connectedClients.delete(otherClient); clientUserIds.delete(ownClient); clientUserIds.delete(otherClient); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('idle scheduler handles an account disabled or removed before the timer fires', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  taskmasterAutoService.schedule('removed-account-session', 999999);
  t.mock.timers.tick(180000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(warning.mock.calls.length, 1);
  assert(String(warning.mock.calls[0].arguments[0]).includes('automatic extraction failed'));
});

test('temporary model congestion retries at one-minute intervals and stops after three attempts', async t => {
  let attempts = 0;
  t.mock.method(taskmasterAutoService, 'extract', async () => { attempts++; throw new AppError('Busy', { code: 'TASKMASTER_MODEL_BUSY', statusCode: 503 }); });
  t.mock.method(console, 'warn', () => {}); t.mock.timers.enable({ apis: ['setTimeout'] });
  taskmasterAutoService.schedule('busy-model-session', testUserId());
  t.mock.timers.tick(180000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 1);
  t.mock.timers.tick(59999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 2);
  t.mock.timers.tick(60000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 3);
  t.mock.timers.tick(600000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 3);
});

test('completion extraction includes recorded tool results without treating plans as completed work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-tool-evidence-')), userId = testUserId();
  withUserContext(userId, () => { projectsDb.createProjectPath(root, 'Evidence'); sessionsDb.createAppSession('tool-evidence-session', 'codex', root, 'Evidence'); });
  t.mock.method(sessionsService, 'fetchHistory', async () => ({ messages: [
    { id: 'user', kind: 'text', role: 'user', content: '写入并读回标记' },
    { id: 'tool', kind: 'tool_use', toolName: 'Bash', toolInput: 'read marker', toolResult: { content: 'marker-ok', isError: false } },
    { id: 'answer', kind: 'text', role: 'assistant', content: '已完成，读回 marker-ok' },
  ], total: 3, hasMore: false, offset: 0, limit: null }));
  let evidence: { role: string; content: string }[] = [];
  t.mock.method(taskmasterWorkspace, 'extract', async (_root: string, _user: number, _session: string, messages: { id: string; role: string; content: string }[]) => { evidence = messages; return { status: 'unchanged', created: 0, updated: 0 }; });
  await withUserContext(userId, () => taskmasterAutoService.extract('tool-evidence-session'));
  assert.equal(evidence.length, 3); assert.equal(evidence[1].role, 'tool'); assert(evidence[1].content.includes('marker-ok'));
});

test('completion debounce resets to three minutes and automatic running sessions skip without a model', async t => {
  let calls = 0;
  t.mock.method(taskmasterAutoService, 'extract', async (_session: string, confirm = false, automatic = false) => { assert.equal(confirm, false); assert.equal(automatic, true); calls++; return { status: 'unchanged', created: 0, updated: 0 }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  taskmasterAutoService.schedule('debounced', testUserId());
  t.mock.timers.tick(170000); taskmasterAutoService.schedule('debounced', testUserId());
  t.mock.timers.tick(179999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 0);
  t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});


test('automatic running sessions skip before reading history and tool evidence retains both ends', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-tool-budget-')), userId = testUserId();
  withUserContext(userId, () => { projectsDb.createProjectPath(root, 'Budget'); sessionsDb.createAppSession('budget-session', 'codex', root, 'Budget'); });
  const running = t.mock.method(chatRunRegistry, 'isProcessing', () => true);
  const history = t.mock.method(sessionsService, 'fetchHistory', async () => ({ messages: [
    { id: 'tool', kind: 'tool_use', toolName: 'Read', toolInput: 'x'.repeat(10000), toolResult: { content: 'HEAD-PASS-' + 'x'.repeat(10000) + '-TAIL-PASS' } },
  ], total: 1, hasMore: false, offset: 0, limit: null }));
  assert.equal((await withUserContext(userId, () => taskmasterAutoService.extract('budget-session', false, true))).status, 'running');
  assert.equal(history.mock.calls.length, 0); running.mock.restore();
  const background = t.mock.method(providerRuntimeService, 'hasBackgroundWork', () => true);
  assert.equal((await withUserContext(userId, () => taskmasterAutoService.extract('budget-session', false, true))).status, 'running');
  assert.equal(history.mock.calls.length, 0); background.mock.restore();
  t.mock.method(taskmasterWorkspace, 'extract', async (_root: string, _user: number, _session: string, messages: { content: string }[]) => {
    assert(messages[0].content.length < 2200); assert(messages[0].content.includes('HEAD-PASS')); assert(messages[0].content.includes('TAIL-PASS'));
    return { status: 'unchanged', created: 0, updated: 0, auditId: null };
  });
  await withUserContext(userId, () => taskmasterAutoService.extract('budget-session', false, true));
});
