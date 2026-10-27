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
import { connectedClients, clientUserIds } from '@/modules/websocket/index.js';
import { withUserContext } from '@/modules/auth/index.js';
import { taskmasterAutoService } from '../taskmaster-auto.service.js';
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
  t.mock.timers.tick(90000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(warning.mock.calls.length, 1);
  assert(String(warning.mock.calls[0].arguments[0]).includes('automatic extraction failed'));
});

test('temporary model congestion retries at one-minute intervals and stops after three attempts', async t => {
  let attempts = 0;
  t.mock.method(taskmasterAutoService, 'extract', async () => { attempts++; throw new AppError('Busy', { code: 'TASKMASTER_MODEL_BUSY', statusCode: 503 }); });
  t.mock.method(console, 'warn', () => {}); t.mock.timers.enable({ apis: ['setTimeout'] });
  taskmasterAutoService.schedule('busy-model-session', testUserId());
  t.mock.timers.tick(90000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 1);
  t.mock.timers.tick(59999); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 2);
  t.mock.timers.tick(60000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 3);
  t.mock.timers.tick(600000); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(attempts, 3);
});
