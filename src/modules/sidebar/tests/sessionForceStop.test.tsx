import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { TFunction } from 'i18next';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import { SessionRow } from '@/modules/sidebar/SessionRow';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ sendMessage }) }));
vi.mock('@/modules/sidebar/hooks/useSessionTitleGeneration', () => ({ useSessionTitleGeneration: () => ({ titleActionLabel: 'Title' }) }));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({ useProviderSessionIdCopy: () => ({ copyLabel: 'Copy ID', setOptionsOpen: () => {}, handleCopyAction: () => {} }) }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/shared/hooks/useMonitorSummaries', () => ({ useMonitorSummaries: () => ({}) }));
const t = ((key: string) => key === 'sessions.forceStop' ? 'Force stop' : key) as TFunction;
const noop = () => {};
function row(running: boolean, background = false) {
  return <SessionRow sessionId="target-session" title="Target" provider="claude" onSelect={noop} t={t}
    options={<SessionOptions sessionId="target-session" sessionName="Target" provider="claude" projectId={null}
      isProcessing={running} hasBackgroundWork={background} isEditing={false} renameDraft="" onRenameDraftChange={noop}
      onStartEditingSession={noop} onCancelEditingSession={noop} onSaveEditingSession={noop} onDeleteSession={noop} t={t} />} />;
}
afterEach(() => { cleanup(); vi.useRealTimers(); sendMessage.mockClear(); });
for (const gesture of ['overflow', 'context', 'touch'] as const) {
  test(`${gesture} menu sends force abort for this running session`, () => {
    const { container } = render(row(true));
    const target = container.querySelector('[data-section-target]')!;
    if (gesture === 'overflow') fireEvent.click(screen.getByRole('button', { name: 'Session options for Target' }));
    if (gesture === 'context') fireEvent.contextMenu(target);
    if (gesture === 'touch') {
      vi.useFakeTimers();
      const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 });
      Object.defineProperty(down, 'pointerType', { value: 'touch' });
      fireEvent(target, down);
      act(() => vi.advanceTimersByTime(550));
      fireEvent.pointerUp(target);
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Force stop' }));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'chat.abort', sessionId: 'target-session', force: true });
    expect(screen.queryByRole('menu')).toBeNull();
  });
}
test('idle sessions hide force stop; background work offers it; completion removes it from an open menu', () => {
  const { rerender } = render(row(false));
  fireEvent.click(screen.getByRole('button', { name: 'Session options for Target' }));
  expect(screen.queryByRole('menuitem', { name: 'Force stop' })).toBeNull();
  rerender(row(false, true));
  expect(screen.getByRole('menuitem', { name: 'Force stop' })).toBeTruthy();
  rerender(row(false));
  expect(screen.queryByRole('menuitem', { name: 'Force stop' })).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
});
