import { afterEach, beforeEach, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import assert from 'node:assert/strict';
import { GlobalTasksPage, TasksNavigation } from '@/modules/task-master/GlobalTasksPage';
import { taskWorkstream } from '@/modules/task-master/utils/taskWorkstreams';

const mocks = vi.hoisted(() => ({ list: vi.fn(), execute: vi.fn(), action: vi.fn(), undo: vi.fn(),views:vi.fn(async()=>({ok:true,json:async()=>[]})) }));
vi.mock('@/shared/api', () => ({ inboxTasksApi: {...mocks,executionSettings:async()=>({ok:true,json:async()=>({provider:'codex',model:'gpt-test',cwd:'/tmp/inbox'})})},api:{providers:{discovery:async()=>({ok:true,json:async()=>({agents:[{id:'codex',installed:true,enabled:true}]})}),capabilities:async()=>({ok:true,json:async()=>({providers:[{provider:'codex',permissionModes:['default','bypassPermissions'],defaultPermissionMode:'bypassPermissions'}]})}),models:async()=>({ok:true,json:async()=>({models:{OPTIONS:[{value:'gpt-test',label:'Test'}],DEFAULT:'gpt-test'}})})}} }));
const reply = (value: unknown) => ({ ok: true, json: async () => value });
const project = { root:'/tmp/inbox', projectId: 'inbox', name: '收件箱待办', audits: [], tasks: [
  { id: 1, title: '核对规格书', description: '核对参数和截止时间', source: '客户会议', due: '2026-10-28', priority: 'high', status: 'pending', recommended: 'B', options: [{ key: 'A', label: '写报告', plan: '输出报告' }, { key: 'B', label: '准备问题', plan: '本人发送' }, { key: 'C', label: '暂缓', plan: '记录原因' }] },
  { id: 2, title: '已完成事项', status: 'done', priority: 'low' },
] };
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue(reply({ projects: [project] })); mocks.execute.mockResolvedValue(reply({ sessionId: 'codex-test' })); mocks.action.mockResolvedValue(reply({ auditId: 'audit' })); mocks.undo.mockResolvedValue(reply({ status: 'undone' })); });
afterEach(cleanup);

test('global tasks default to open, preserve all options and explicitly dispatch the selected option', async () => {
  render(<MemoryRouter initialEntries={['/tasks?view=legacy']}><GlobalTasksPage onMenuClick={() => {}}/></MemoryRouter>);
  await screen.findByText('核对规格书'); assert(!screen.queryByText('已完成事项'));
  fireEvent.click(screen.getByText('核对规格书'));
  assert(screen.getByText('C · 暂缓')); assert((screen.getAllByRole('radio')[1] as HTMLInputElement).checked);
  fireEvent.click(screen.getAllByRole('radio')[0]); fireEvent.click(screen.getByText('执行', { exact: true }));
  fireEvent.click(await screen.findByRole('button',{name:'确认执行并打开对话'}));
  await waitFor(() => assert.deepEqual(mocks.execute.mock.calls[0], ['inbox', '1', 'A', '',{provider:'codex',model:'gpt-test',cwd:'/tmp/inbox',effort:'',permissionMode:'bypassPermissions',userInput:''}]));
  assert.equal(mocks.action.mock.calls.length, 0);
});
test('completion returns an undo receipt, and status filter includes completed tasks', async () => {
  render(<MemoryRouter initialEntries={['/tasks?view=legacy']}><GlobalTasksPage onMenuClick={() => {}}/></MemoryRouter>);
  await screen.findByText('核对规格书'); fireEvent.click(screen.getByText('核对规格书')); fireEvent.click(screen.getByText('标记完成'));
  await screen.findByText('撤销'); fireEvent.click(screen.getByText('撤销'));
  await waitFor(() => assert.deepEqual(mocks.undo.mock.calls[0], ['inbox', 'audit']));
  fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'done' } });
  await screen.findByText('已完成事项'); assert(!screen.queryByText('核对规格书'));
});
test('sidebar entry counts unfinished and high priority tasks', async () => {
  render(<MemoryRouter><TasksNavigation/></MemoryRouter>);
  await screen.findByRole('button', { name: '任务，需要你处理 0 · 未完成 1' }); assert.equal(screen.queryByLabelText('1 项高优先级'),null);
});

test('task loading is not reported as an empty collection', () => {
  mocks.list.mockReturnValue(new Promise(() => {}));
  render(<MemoryRouter initialEntries={['/tasks?view=legacy']}><GlobalTasksPage onMenuClick={() => {}}/></MemoryRouter>);
  assert(screen.getByRole('status').textContent?.includes('正在加载'));
  assert(!screen.queryByText('暂无任务'));
});

test('workstreams keep robot operations together and distinguish research from its execution tools', () => {
  assert.equal(taskWorkstream('每15分钟巡检 RPW 真机 RAX 抓取'), 'robotics');
  assert.equal(taskWorkstream('使用 Codex 复现 RAX 并统计开销'), 'research');
  assert.equal(taskWorkstream('补齐 CATL 技术规格书与 BOM'), 'delivery');
  assert.equal(taskWorkstream('为 Nexagent 接入 DeepSeek Harness'), 'platform');
  assert.equal(taskWorkstream('核对其他事项'), 'followup');
});

test('all tasks and options are visible by default; explicit collapse and search preserve hidden tasks', async () => {
  const tasks = Array.from({length:5}, (_,i) => ({id:i+1,title:`Nexagent 任务 ${i+1}`,status:'pending',priority:'medium'}));
  mocks.list.mockResolvedValue(reply({projects:[{...project,tasks}]}));
  render(<MemoryRouter initialEntries={['/tasks?view=legacy']}><GlobalTasksPage onMenuClick={() => {}}/></MemoryRouter>);
  await screen.findByText('Nexagent 任务 1');
  assert.equal(screen.getAllByTestId('global-task-row').length,5);
  fireEvent.click(screen.getByRole('button',{name:'按大类'}));
  fireEvent.click(screen.getByRole('button',{name:'收起为重点概览'}));
  assert.equal(screen.getAllByTestId('global-task-row').length,3);
  fireEvent.click(screen.getByRole('button',{name:'展开其余 2 项'}));
  assert.equal(screen.getAllByTestId('global-task-row').length,5);
  fireEvent.click(screen.getByRole('button',{name:'收起为重点概览'}));
  fireEvent.change(screen.getByRole('textbox',{name:'搜索任务'}),{target:{value:'任务 5'}});
  await screen.findByText('Nexagent 任务 5');
  assert.equal(screen.getAllByTestId('global-task-row').length,1);
  assert.equal(mocks.action.mock.calls.length,0);
  assert.equal(mocks.execute.mock.calls.length,0);
});
