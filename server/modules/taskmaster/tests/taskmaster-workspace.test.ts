import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskmasterWorkspaceService } from '../taskmaster-workspace.service.js';

const message = (id: string, content: string) => ({ id, role: 'user', content });
const item = (title: string, messageId: string, evidence: string, extra = {}) => ({ title, messageId, evidence, confidence: 0.98, ...extra });
const root = () => mkdtemp(path.join(os.tmpdir(), 'nexagent-taskmaster-'));

test('native initialization is idempotent and preserves existing tasks/config without subprocesses', async () => {
  const project = await root(); const service = createTaskmasterWorkspaceService(async () => { throw new Error('initialization must not invoke a model'); });
  assert.equal((await service.initialize(project)).taskCount, 0);
  const configFile = path.join(project, '.taskmaster/config.json'), config = await readFile(configFile, 'utf8');
  assert.equal(JSON.parse(config).models.main.provider, 'claude-code'); assert.equal(JSON.parse(config).models.fallback.provider, 'codex-cli');
  await service.add(project, { title: '保留任务', description: '用户原任务' }); await service.initialize(project);
  assert.equal((await service.list(project, 1)).tasks.length, 1); assert.equal(await readFile(configFile, 'utf8'), config);
});

test('incremental cursor, semantic ids, concurrent extraction, status evidence and undo survive service recreation', async () => {
  const project = await root(); let calls = 0; const inputs: unknown[] = [];
  const responses = [
    { tasks: [item('实现登录页面', '1', '实现登录页面'), item('新增导出报告', '1', '新增导出报告')] },
    { tasks: [item('登录界面开发', '2', '登录页面已完成', { taskId: 1, status: 'done' })] },
  ];
  const service = createTaskmasterWorkspaceService(async input => { inputs.push(input); calls++; return responses.shift(); });
  const first = [message('1', '请实现登录页面，以及新增导出报告。')];
  await Promise.all([service.extract(project, 1, 'session-a', first, false), service.extract(project, 1, 'session-a', first, false)]);
  assert.equal(calls, 1); assert.equal((await service.list(project, 1)).tasks.length, 2);
  const second = [...first, message('2', '登录页面已完成，导出还未开始。')];
  const change = await service.extract(project, 1, 'session-a', second, false);
  assert.equal((inputs[1] as { messages: unknown[] }).messages.length, 1);
  assert.equal((await service.list(project, 1)).tasks[0].status, 'done');
  const resumed = createTaskmasterWorkspaceService(async () => { throw new Error('processed history must not be regenerated'); });
  assert.equal((await resumed.extract(project, 1, 'session-a', second, false)).status, 'unchanged');
  await resumed.undo(project, 1, 'session-a', change.auditId!);
  assert.equal((await resumed.list(project, 1)).tasks[0].status, 'pending');
  await assert.rejects(resumed.undo(project, 2, 'session-a', change.auditId!));
});

test('low confidence/suggest-only require confirmation and false source quotes never become tasks', async () => {
  const project = await root(); const messages = [message('1', '考虑加入搜索，也需要修复登录。')];
  const service = createTaskmasterWorkspaceService(async () => ({ tasks: [item('加入搜索', '1', '考虑加入搜索', { confidence: .5 }), item('修复登录', '1', '修复登录'), item('虚构任务', '1', '这个证据不存在')] }));
  await service.extract(project, 1, 's', messages, true);
  assert.equal((await service.list(project, 1)).tasks.length, 0); assert.equal((await service.snapshot(project, 1, 's')).suggestions.length, 2);
  await service.extract(project, 1, 's', messages, true, true);
  assert.equal((await service.list(project, 1)).tasks.length, 2); assert.equal((await service.snapshot(project, 1, 's')).suggestions.length, 0);
});

test('undo refuses newer manual edits, history edits reprocess the first changed position', async () => {
  const project = await root(); let calls = 0;
  const service = createTaskmasterWorkspaceService(async () => { calls++; return { tasks: [item('实现登录页面', '1', '实现登录页面')] }; });
  const messages = [message('1', '实现登录页面')], result = await service.extract(project, 1, 's', messages, false);
  await service.update(project, '1', { status: 'in-progress' });
  await assert.rejects(service.undo(project, 1, 's', result.auditId!), /新改动/);
  await service.extract(project, 1, 's', [message('1', '重新实现登录页面')], false); assert.equal(calls, 2);
  assert.equal((await service.list(project, 1)).tasks.length, 1);
});

test('account snapshots do not expose another account sources/audits even on a shared task', async () => {
  const project = await root(); const service = createTaskmasterWorkspaceService(async (input: unknown) => {
    const m = (input as { messages: { id: string; content: string }[] }).messages[0]; return { tasks: [item('修复项目登录', m.id, m.content)] };
  });
  await service.extract(project, 1, 'private-a', [message('a', '修复项目登录')], false);
  await service.extract(project, 2, 'private-b', [message('b', '修复项目登录')], false);
  const snapshot = await service.snapshot(project, 2, 'private-b');
  assert.equal(snapshot.tasks.length, 1); assert(!JSON.stringify(snapshot).includes('private-a'));
  assert.equal((await service.snapshot(project, 2, 'private-a')).tasks.length, 0);
});

test('active tag and unrelated tags are preserved and malformed task data fails without overwriting', async () => {
  const project = await root(); const service = createTaskmasterWorkspaceService(async () => ({ tasks: [] })); await service.initialize(project);
  const file = path.join(project, '.taskmaster/tasks/tasks.json');
  await writeFile(file, JSON.stringify({ master: { tasks: [{ id: 1, title: '保留基线', status: 'done' }] }, feature: { tasks: [] } }));
  await writeFile(path.join(project, '.taskmaster/state.json'), JSON.stringify({ currentTag: 'feature' }));
  await service.add(project, { title: '当前标签任务' }); const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.master.tasks[0].title, '保留基线'); assert.equal(data.feature.tasks.length, 1);
  await writeFile(file, '{broken'); await assert.rejects(service.add(project, { title: '不得覆盖' })); assert.equal(await readFile(file, 'utf8'), '{broken');
});
