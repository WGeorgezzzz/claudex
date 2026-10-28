import assert from 'node:assert/strict';
import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';
import { useQueuedTurnSync } from '@/modules/chat/hooks/useQueuedTurnSync';
import type { QueuedConversationMessage } from '@/shared/types';

const row = (status: QueuedConversationMessage['status'], session_id = 'task-chat') => ({
  id: 'request-1', session_id, status, attempt_count: 1,
} as QueuedConversationMessage);

test('a task opened before dispatch attaches when it starts and refreshes its completed reply', () => {
  const sync = vi.fn();
  const view = renderHook(({ items }) => useQueuedTurnSync('task-chat', items, sync), { initialProps: { items: [row('queued')] } });
  assert.equal(sync.mock.calls.length, 0, 'idle subscription alone cannot see a future run');
  view.rerender({ items: [row('running')] });
  assert.equal(sync.mock.calls.length, 1, 'reattach to the newly registered detached run');
  view.rerender({ items: [row('running')] });
  assert.equal(sync.mock.calls.length, 1, 'unchanged poll does not replay the stream repeatedly');
  view.rerender({ items: [row('succeeded')] });
  assert.equal(sync.mock.calls.length, 2, 'load the persisted result even if the last frame was missed');
  view.unmount();
});

test('a fast completed task catches up on first observation while stale sessions and live receipts do not', () => {
  const sync = vi.fn();
  const view = renderHook(({ id, items }) => useQueuedTurnSync(id, items, sync), {
    initialProps: { id: 'other-chat', items: [row('succeeded')] },
  });
  assert.equal(sync.mock.calls.length, 0);
  view.rerender({ id: 'task-chat', items: [{ ...row('succeeded'), delivery_mode: 'live' }] });
  assert.equal(sync.mock.calls.length, 0);
  view.rerender({ id: 'task-chat', items: [row('succeeded')] });
  assert.equal(sync.mock.calls.length, 1);
  view.unmount();
});
