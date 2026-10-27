import { afterEach, beforeEach, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import assert from 'node:assert/strict';
import { GlobalTasksPage, TasksNavigation } from '@/modules/task-master/GlobalTasksPage';

const mocks = vi.hoisted(() => ({ list: vi.fn(), execute: vi.fn(), action: vi.fn(), undo: vi.fn() }));
vi.mock('@/shared/api', () => ({ inboxTasksApi: mocks }));
const reply = (value: unknown) => ({ ok: true, json: async () => value });
const project = { projectId: 'inbox', name: '收件箱待办', audits: [], tasks: [
  { id: 1, title: '核对规格书', description: '核对参数和截止时间', source: '客户会议', due: '2026-10-28', priority: 'high', status: 'pending', recommended: 'B', options: [{ key: 'A', label: '写报告', plan: '输出报告' }, { key: 'B', label: '准备问题', plan: '本人发送' }, { key: 'C', label: '暂缓', plan: '记录原因' }] },
  { id: 2, title: '已完成事项', status: 'done', priority: 'low' },
] };
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue(reply({ projects: [project] })); mocks.execute.mockResolvedValue(reply({ sessionId: 'codex-test' })); mocks.action.mockResolvedValue(reply({ auditId: 'audit' })); mocks.undo.mockResolvedValue(reply({ status: 'undone' })); });
afterEach(cleanup);

test('global tasks default to open, preserve all options and explicitly dispatch the selected option', async () => {
  render(<MemoryRouter><GlobalTasksPage onMenuClick={() => {}}/></MemoryRouter>);
  await screen.findByText('核对规格书'); assert(!screen.queryByText('已完成事项'));
  fireEvent.click(screen.getByText('核对规格书'));
  assert(screen.getByText('C · 暂缓')); assert((screen.getAllByRole('radio')[1] as HTMLInputElement).checked);
  fireEvent.click(screen.getAllByRole('radio')[0]); fireEvent.click(screen.getByText('执行', { exact: true }));
  await waitFor(() => assert.deepEqual(mocks.execute.mock.calls[0], ['inbox', '1', 'A']));
  assert.equal(mocks.action.mock.calls.length, 0);
});
test('completion returns an undo receipt, and status filter includes completed tasks', async () => {
  render(<MemoryRouter><GlobalTasksPage onMenuClick={() => {}}/></MemoryRouter>);
  await screen.findByText('核对规格书'); fireEvent.click(screen.getByText('核对规格书')); fireEvent.click(screen.getByText('标记完成'));
  await screen.findByText('撤销'); fireEvent.click(screen.getByText('撤销'));
  await waitFor(() => assert.deepEqual(mocks.undo.mock.calls[0], ['inbox', 'audit']));
  fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'done' } });
  await screen.findByText('已完成事项'); assert(!screen.queryByText('核对规格书'));
});
test('sidebar entry counts unfinished and high priority tasks', async () => {
  render(<MemoryRouter><TasksNavigation/></MemoryRouter>);
  await screen.findByRole('button', { name: '任务，1 项未完成' }); assert(screen.getByLabelText('1 项高优先级'));
});
