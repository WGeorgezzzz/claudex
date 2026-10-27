import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import { SessionWorkspaceProvider } from '@/modules/sidebar/context/SessionWorkspaceContext';
import { SessionInbox } from '@/modules/sidebar/modals/SessionInbox';
import type { SessionWorkspaceEntry } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { sessionWorkspace: { list: vi.fn(), update: vi.fn() } }, readApiErrorMessage: () => '' }));
const base: SessionWorkspaceEntry = { sessionId: 'alpha', title: 'Alpha review', provider: 'claude', projectId: 'p1', projectPath: '/alpha project', pinnedAt: null, unread: true, queuePaused: false, lastActivityAt: '2026-10-22T00:00:00.000Z', queuedCount: 0, runningCount: 0, blockedCount: 0, approvalCount: 0 };
const response = (data: unknown) => new Response(JSON.stringify({ data }));
let rows: SessionWorkspaceEntry[];
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  rows = [{ ...base }, { ...base, sessionId: 'beta', title: 'Beta approval', projectId: 'p2', projectPath: '/beta', approvalCount: 1, blockedCount: 2 }];
  vi.mocked(api.sessionWorkspace.list).mockImplementation(async () => response(rows));
  vi.mocked(api.sessionWorkspace.update).mockImplementation(async (id, input) => {
    const index = rows.findIndex(row => row.sessionId === id);
    rows[index] = { ...rows[index], ...(input.unread !== undefined ? { unread: input.unread } : {}), ...(input.pinned !== undefined ? { pinnedAt: input.pinned ? 42 : null } : {}) };
    return response(rows[index]);
  });
});
afterEach(() => vi.restoreAllMocks());
async function open(select = vi.fn()) {
  render(<SessionWorkspaceProvider activeSessionId={null}><SessionInbox onSelect={select}/></SessionWorkspaceProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Session inbox|会话收件箱/ }));
  return screen.getByRole('dialog');
}

test('inbox browsing preserves unread state, shows simultaneous blockers and navigates only on selection', async () => {
  const select = vi.fn(); const dialog = await open(select);
  const article = within(dialog).getByRole('article', { name: 'Beta approval' });
  assert.match(article.textContent!, /1.*approval|审批.*1|1.*审批/i);
  assert.match(article.textContent!, /2.*failed|2.*失败|失败.*2/i);
  assert.equal(vi.mocked(api.sessionWorkspace.update).mock.calls.length, 0);
  fireEvent.click(within(article).getByRole('link'));
  assert.deepEqual(select.mock.calls, [['p2', 'beta', 'claude']]);
  assert.equal(Boolean(screen.queryByRole('dialog')), false);
});

test('bulk read only acknowledges the search results through their displayed activity timestamp', async () => {
  const dialog = await open();
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'alpha project' } });
  assert.equal(Boolean(within(dialog).queryByRole('article', { name: 'Beta approval' })), false);
  fireEvent.click(within(dialog).getByRole('button', { name: /Mark shown read|将筛选结果标为已读/ }));
  await waitFor(() => assert.equal(Boolean(within(dialog).queryByRole('article', { name: 'Alpha review' })), false));
  assert.deepEqual(vi.mocked(api.sessionWorkspace.update).mock.calls, [['alpha', { unread: false, readThrough: base.lastActivityAt }]]);
});

test('a completion newer than the acknowledged snapshot stays unread', async () => {
  vi.mocked(api.sessionWorkspace.update).mockImplementation(async () => response({ ...base, lastActivityAt: '2026-10-22T00:01:00.000Z', unread: true }));
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Session options for Alpha review' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Mark Alpha review read|将 Alpha review 标为已读/ }));
  await waitFor(() => assert.equal(vi.mocked(api.sessionWorkspace.update).mock.calls.length,1));
  assert.deepEqual(vi.mocked(api.sessionWorkspace.update).mock.calls[0], ['alpha', { unread: false, readThrough: base.lastActivityAt }]);
  assert.ok(within(dialog).getByRole('article', { name: 'Alpha review' }));
});

test('partial batch failure remains visible after later successes and duplicate clicks do not reissue writes', async () => {
  vi.mocked(api.sessionWorkspace.update).mockImplementation(async (id) => {
    if (id === 'beta') throw new Error('unavailable');
    return response({ ...base, unread: false });
  });
  const dialog = await open();
  const batch = within(dialog).getByRole('button', { name: /Mark shown read|将筛选结果标为已读/ });
  await act(async () => { fireEvent.click(batch); fireEvent.click(batch); });
  await waitFor(() => assert.match(within(dialog).getByRole('alert').textContent!, /1/));
  assert.equal(vi.mocked(api.sessionWorkspace.update).mock.calls.length, 2);
  assert.ok(within(dialog).getByRole('article', { name: 'Beta approval' }));
});

test('pin and unread controls never navigate or mutate queue permissions', async () => {
  const select = vi.fn(); const dialog = await open(select);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Session options for Alpha review' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /^Pin Alpha review$|^置顶 Alpha review$/ }));
  await waitFor(() => assert.deepEqual(vi.mocked(api.sessionWorkspace.update).mock.calls, [['alpha', { pinned: true }]]));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Session options for Alpha review' }));
  assert.ok(await screen.findByRole('menuitem', { name: /^Unpin Alpha review$|^取消置顶 Alpha review$/ }));
  assert.deepEqual(vi.mocked(api.sessionWorkspace.update).mock.calls, [['alpha', { pinned: true }]]);
  assert.equal(select.mock.calls.length, 0);
});

test('older or unavailable servers do not expose unsupported inbox actions', async () => {
  vi.mocked(api.sessionWorkspace.list).mockResolvedValue(new Response('{}', { status: 404 }));
  render(<SessionWorkspaceProvider activeSessionId={null}><SessionInbox onSelect={vi.fn()}/></SessionWorkspaceProvider>);
  await waitFor(() => assert.equal(vi.mocked(api.sessionWorkspace.list).mock.calls.length, 1));
  assert.equal(Boolean(screen.queryByRole('button', { name: /Session inbox|会话收件箱/ })), false);
});
