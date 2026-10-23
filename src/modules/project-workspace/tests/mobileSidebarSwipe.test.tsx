import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

import { useMobileSidebarSwipe } from '@/modules/project-workspace/hooks/useMobileSidebarSwipe';

function Fixture({ mobile = true }: { mobile?: boolean }) {
  // The fixture exercises the same state transition as the mobile workspace drawer.
  const [open, setOpen] = useState(false);
  useMobileSidebarSwipe(mobile, open, setOpen);
  return <div className="workspace-shell">
    <div data-testid="conversation">Conversation</div>
    <output>{open ? 'open' : 'closed'}</output>
    <textarea aria-label="Draft" defaultValue="Keep this draft" />
    <pre>Scrollable shell code</pre>
    <button onClick={() => setOpen(false)}>Close</button>
  </div>;
}

function swipe(target: Element, from: [number, number], to: [number, number]) {
  fireEvent.touchStart(target, { touches: [{ clientX: from[0], clientY: from[1] }] });
  fireEvent.touchMove(target, { touches: [{ clientX: to[0], clientY: to[1] }] });
  fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: to[0], clientY: to[1] }] });
}

test('right swipe opens and left swipe closes without navigation or draft loss', () => {
  render(<Fixture />);
  const location = window.location.href;
  const conversation = screen.getByTestId('conversation');
  swipe(conversation, [40, 300], [210, 305]);
  expect(screen.getByText('open')).toBeTruthy();
  swipe(conversation, [210, 300], [40, 305]);
  expect(screen.getByText('closed')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this draft');
  expect(window.location.href).toBe(location);
});

test('vertical scroll, short drags and the opposite direction do not open the sidebar', () => {
  render(<Fixture />);
  const conversation = screen.getByTestId('conversation');
  for (const to of [[210, 450], [80, 305], [0, 300]] as [number, number][]) {
    swipe(conversation, [40, 300], to);
    expect(screen.getByText('closed')).toBeTruthy();
  }
});

test('inputs, code blocks and active text selection retain their gestures', () => {
  render(<Fixture />);
  swipe(screen.getByRole('textbox'), [40, 300], [210, 305]);
  swipe(screen.getByText('Scrollable shell code'), [40, 300], [210, 305]);
  const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected text' } as Selection);
  swipe(screen.getByTestId('conversation'), [40, 300], [210, 305]);
  selection.mockRestore();
  expect(screen.getByText('closed')).toBeTruthy();
});

test('multi-touch and cancelled gestures do not change the drawer', () => {
  render(<Fixture />);
  const conversation = screen.getByTestId('conversation');
  fireEvent.touchStart(conversation, { touches: [{ clientX: 40, clientY: 300 }, { clientX: 60, clientY: 300 }] });
  fireEvent.touchMove(conversation, { touches: [{ clientX: 210, clientY: 300 }] });
  fireEvent.touchEnd(conversation, { touches: [], changedTouches: [{ clientX: 210, clientY: 300 }] });
  expect(screen.getByText('closed')).toBeTruthy();
  fireEvent.touchStart(conversation, { touches: [{ clientX: 40, clientY: 300 }] });
  fireEvent.touchCancel(conversation);
  fireEvent.touchEnd(conversation, { touches: [], changedTouches: [{ clientX: 210, clientY: 300 }] });
  expect(screen.getByText('closed')).toBeTruthy();
});

test('the trailing click is ignored but a new deliberate touch is accepted', () => {
  render(<Fixture />);
  swipe(screen.getByTestId('conversation'), [40, 300], [210, 305]);
  const close = screen.getByRole('button', { name: 'Close' });
  fireEvent.click(close, { detail: 1, clientX: 210, clientY: 305 });
  expect(screen.getByText('open')).toBeTruthy();
  fireEvent.touchStart(close, { touches: [{ clientX: 210, clientY: 305 }] });
  fireEvent.touchEnd(close, { touches: [], changedTouches: [{ clientX: 210, clientY: 305 }] });
  fireEvent.click(close, { detail: 1, clientX: 210, clientY: 305 });
  expect(screen.getByText('closed')).toBeTruthy();
});

test('desktop touch and a gesture outside the workspace do not open the sidebar', () => {
  render(<Fixture mobile={false} />);
  swipe(screen.getByTestId('conversation'), [40, 300], [210, 305]);
  swipe(document.body, [40, 300], [210, 305]);
  expect(screen.getByText('closed')).toBeTruthy();
});
