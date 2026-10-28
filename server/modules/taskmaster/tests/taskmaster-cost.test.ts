import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskmasterWorkspaceService } from '../taskmaster-workspace.service.js';

test('automatic first pass selects latest 40, persists watermarks, skips and resumes after recreation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cost-'));
  const inputs: { messages: { id: string; content: string }[] }[] = [];
  const service = createTaskmasterWorkspaceService(async input => { inputs.push(input as typeof inputs[number]); return { tasks: [] }; });
  const messages = Array.from({ length: 100 }, (_, n) => ({ id: String(n), role: 'user', content: '任务 ' + n }));
  await service.extract(root, 1, 's', messages, false, false, true);
  assert.equal(inputs[0].messages.length, 40); assert.equal(inputs[0].messages[0].id, '60');
  const resumed = createTaskmasterWorkspaceService(async input => { inputs.push(input as typeof inputs[number]); return { tasks: [] }; });
  assert.equal((await resumed.extract(root, 1, 's', messages, false, false, true)).status, 'unchanged');
  messages.push({ id: '100', role: 'assistant', content: '我正在思考' });
  assert.equal((await resumed.extract(root, 1, 's', messages, false, false, true)).status, 'no-actionable-messages');
  messages.push({ id: '101', role: 'tool', content: 'Tests passed: 42' });
  await resumed.extract(root, 1, 's', messages, false, false, true);
  assert.deepEqual(inputs[1].messages.map(m => m.id), ['101']);
  const state = JSON.parse(await readFile(path.join(root, '.taskmaster/tasks/tasks.json'), 'utf8')).master.metadata.nexagent;
  assert.equal(state.watermarks['1:s'].id, '101');
});

test('bounded serialized input drops oldest messages, includes compact unfinished tasks, keeps failure watermark', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-budget-'));
  let captured = ''; let fail = true;
  const service = createTaskmasterWorkspaceService(async input => { captured = JSON.stringify(input); if (fail) throw Error('relay failed'); return { tasks: [] }; });
  await service.add(root, { title: '未完成', description: 'x'.repeat(4000) });
  await service.add(root, { title: '已完成' }); await service.update(root, '2', { status: 'done' });
  const messages = Array.from({ length: 100 }, (_, n) => ({ id: String(n), role: 'user', content: ('quote " newline\n 中文 ').repeat(1000) }));
  await assert.rejects(service.extract(root, 1, 's', messages, false, false, true));
  const before = JSON.parse(await readFile(path.join(root, '.taskmaster/tasks/tasks.json'), 'utf8')).master.metadata.nexagent;
  assert.equal(before.watermarks?.['1:s'], undefined);
  fail = false; await service.extract(root, 1, 's', messages, false, false, true);
  assert(captured.length <= 22000); const input = JSON.parse(captured);
  assert.equal(input.messages.at(-1).id, '99'); assert(input.messages.length < 40);
  assert.deepEqual(input.existingTasks.map((t: { title: string }) => t.title), ['未完成']);
  assert(!captured.includes('description'));
});

test('single escaped message still fits instead of silently sending an empty evidence window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-escaped-'));
  const service = createTaskmasterWorkspaceService(async input => {
    const data = input as { messages: { content: string }[] };
    assert(JSON.stringify(input).length <= 22000); assert.equal(data.messages.length, 1); assert(data.messages[0].content.length > 0);
    return { tasks: [] };
  });
  await service.extract(root, 1, 's', [{ id: 'u', role: 'user', content: '\u0001'.repeat(10000) }], false, false, true);
});
