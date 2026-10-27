import { afterEach, beforeEach, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { ConversationTasksPanel } from '@/modules/task-master/ConversationTasksPanel';
import TaskMasterSetupModal from '@/modules/task-master/modals/TaskMasterSetupModal';

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), conversation: vi.fn(), action: vi.fn(), settings: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { taskmaster: { initialize: mocks.initialize, conversation: mocks.conversation, conversationAction: mocks.action,
  autoSettings: mocks.settings, saveAutoSettings: mocks.settings } } }));
const reply = (value: unknown) => ({ ok: true, json: async () => value });
const snapshot = { tasks: [{ id: 1, title: '实现登录页面', status: 'done', description: '中文任务', autoUpdate: { evidence: '登录页面已完成' }, sources: [{ sessionId: 's', messageId: 'm', evidence: '登录页面已完成' }] }, { id: 2, title: '生成导出报告', status: 'pending' }],
  suggestions: [{ title: '加入搜索', evidence: '考虑搜索' }], audits: [{ id: 'audit', at: '2026-10-27T07:00:00Z', changes: [{}] }], root: 'D:/test', error: null };
beforeEach(() => { vi.clearAllMocks(); mocks.conversation.mockResolvedValue(reply(snapshot)); mocks.action.mockResolvedValue(reply({ status: 'ready' })); mocks.settings.mockResolvedValue(reply({ enabled: true, suggestOnly: false, disabledProjects: [] })); });
afterEach(cleanup);

test('initialization uses a normal request, shows progress, preserves error and retries without a terminal', async () => {
  mocks.initialize.mockResolvedValueOnce({ ok: false, json: async () => ({ message: '项目不可写' }) }).mockResolvedValueOnce(reply({ status: 'configured' }));
  const after = vi.fn(); const { container } = render(<TaskMasterSetupModal isOpen project={{ projectId: 'p', displayName: '测试项目', fullPath: 'D:/test' }} onClose={() => {}} onAfterClose={after}/>);
  fireEvent.click(screen.getByText('一键初始化')); await screen.findByText('项目不可写');
  fireEvent.click(screen.getByText('重试初始化')); await screen.findByText('已准备好'); assert.equal(after.mock.calls.length, 1);
  assert.equal(container.querySelector('.xterm'), null); assert(!container.textContent?.includes('npx')); assert.equal(mocks.initialize.mock.calls.length, 2);
});

test('conversation panel renders completion evidence and source/execution callbacks without dispatching automatically', async () => {
  const execute = vi.fn(), source = vi.fn(); render(<ConversationTasksPanel sessionId="s" busy={false} onExecute={execute} onSource={source}/>);
  await screen.findByText('实现登录页面'); assert.equal(execute.mock.calls.length, 0);
  fireEvent.click(screen.getByText('查看原对话位置')); assert.deepEqual(source.mock.calls[0], ['m', '登录页面已完成']);
  fireEvent.click(screen.getByText('发到当前对话执行')); assert(String(execute.mock.calls[0][0]).includes('生成导出报告'));
  assert(screen.getByText('自动更新：依据 登录页面已完成'));
});

test('manual extraction, confirmation and undo share ordinary authenticated operations', async () => {
  render(<ConversationTasksPanel sessionId="s" busy={false} onExecute={() => {}} onSource={() => {}}/>);
  await screen.findByText('加入搜索 · 考虑搜索');
  fireEvent.click(screen.getByText('从本对话整理任务')); await waitFor(() => assert.equal(mocks.action.mock.calls[0][1], 'extract'));
  await waitFor(() => assert.equal(screen.getByText('确认这些建议').hasAttribute('disabled'), false)); fireEvent.click(screen.getByText('确认这些建议'));
  await waitFor(() => assert.equal(mocks.action.mock.calls[1][1], 'confirm'));
  await waitFor(() => assert.equal(screen.getByText('撤销').hasAttribute('disabled'), false)); fireEvent.click(screen.getByText('撤销'));
  await waitFor(() => assert.deepEqual(mocks.action.mock.calls[2], ['s', 'undo', 'audit']));
});

test('busy conversation disables extraction and task execution', async () => {
  render(<ConversationTasksPanel sessionId="s" busy onExecute={() => {}} onSource={() => {}}/>); await screen.findByText('生成导出报告');
  assert(screen.getByText('从本对话整理任务').hasAttribute('disabled')); assert(screen.getByText('发到当前对话执行').hasAttribute('disabled'));
});
