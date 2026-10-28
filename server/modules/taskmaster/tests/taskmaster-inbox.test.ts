import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskmasterWorkspaceService } from '../taskmaster-workspace.service.js';

const item = (id = 1) => ({ id, title: '准备客户技术规格和物料清单', detail: '需要核对参数，输出材料由本人发送', source: '客户会议', due: '2026-10-28', urgency: '高', options: [{ key: 'A', label: '准备材料', plan: '核对并写入文档' }, { key: 'B', label: '先问清楚', plan: '列出问题' }, { key: 'C', label: '暂缓', plan: '记录原因' }], recommended: 'A' });
test('inbox imports preserve options, deduplicate concurrent batches, retain completed tasks and audit undo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-tasks-'));
  const service = createTaskmasterWorkspaceService(async () => { throw Error('imports must not call a model'); });
  await service.initialize(root);
  const [a, b] = await Promise.all([service.importInbox(root, 1, 'batch-1', [item()]), service.importInbox(root, 1, 'batch-1', [item()])]);
  assert.equal(a.auditId, b.auditId); assert.equal((await service.list(root, 1)).tasks.length, 1);
  const task = (await service.list(root, 1)).tasks[0] as Record<string, unknown>;
  assert.equal(task.priority, 'high'); assert.equal(task.due, '2026-10-28'); assert.equal((task.options as unknown[]).length, 3);
  await assert.rejects(service.importInbox(root, 1, 'batch-1', [{ ...item(), detail: 'different' }]), /批次/);
  await service.importInbox(root, 1, 'batch-2', [{ ...item(2), detail: '追加验收标准' }]);
  assert.equal((await service.list(root, 1)).tasks.length, 1);
  const receipt = await service.changeInboxTask(root, 1, '1', async () => ({ status: 'done' }));
  const before = await readFile(path.join(root, '.taskmaster/tasks/tasks.json'), 'utf8');
  const extraEvidence=await service.importInbox(root, 1, 'batch-3', [{ ...item(), detail: '不能改完成事项' }]);
  assert.equal(((await service.list(root, 1)).tasks[0] as Record<string, unknown>).description, '追加验收标准');
  assert(before.includes('done'));
  await assert.rejects(service.undo(root, 2, 'global', receipt.auditId!), /找不到/);
  await service.undo(root,1,'global',extraEvidence.auditId!);
  await service.undo(root, 1, 'global', receipt.auditId!);
  assert.equal((await service.list(root, 1)).tasks[0].status, 'pending');
});

test('execution association serializes duplicate clicks and cannot be undone as a manual status change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-execute-'));
  const service = createTaskmasterWorkspaceService(async () => ({}));
  await service.importInbox(root, 1, 'batch', [item()]);
  let launches = 0;
  const execute = () => service.changeInboxTask(root, 1, '1', async task => {
    if (task.executionSessionId) return { executionSessionId: task.executionSessionId };
    launches++; return { status: 'in-progress', executionSessionId: 'codex-session' };
  });
  const results = await Promise.all([execute(), execute()]); assert.equal(launches, 1);
  assert(results.every(r => r.task.executionSessionId === 'codex-session' && r.auditId === null));
});

test('test cleanup requires completed exact local-test identity and retains a deletion receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-cleanup-'));
  const service = createTaskmasterWorkspaceService(async () => ({}));
  await service.importInbox(root, 1, 'test', [{ ...item(), title: '[测试] 可删除验收任务', source: '本地验收' }]);
  await assert.rejects(service.removeCompletedTest(root, 1, '1', '[测试] 可删除验收任务'), /仅允许/);
  await service.changeInboxTask(root, 1, '1', async () => ({ status: 'done' }));
  await assert.rejects(service.removeCompletedTest(root, 1, '1', 'wrong'), /仅允许/);
  await service.removeCompletedTest(root, 1, '1', '[测试] 可删除验收任务');
  assert.equal((await service.list(root, 1)).tasks.length, 0);
  assert((await readFile(path.join(root, '.taskmaster/tasks/tasks.json'), 'utf8')).includes('test-cleanup'));
});
