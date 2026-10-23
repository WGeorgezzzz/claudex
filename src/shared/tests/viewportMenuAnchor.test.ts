import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useViewportMenuAnchor } from '@/shared/hooks/useViewportMenuAnchor';

afterEach(() => vi.unstubAllGlobals());

function openMenu(right = 91, top = 807) {
  const onClose = vi.fn();
  const { result, unmount } = renderHook(() => useViewportMenuAnchor(true, onClose, 352));
  const button = document.createElement('button');
  button.getBoundingClientRect = () => ({ right, top, bottom: top + 26 } as DOMRect);
  result.current.triggerRef.current = button;
  act(() => result.current.updateAnchor());
  return { result, unmount };
}

test('left-edge permission and model menus fit a narrow phone viewport', () => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  for (const right of [91, 102]) {
    const { result, unmount } = openMenu(right);
    const anchor = result.current.anchor!;
    expect(390 - anchor.right - anchor.maxWidth).toBeGreaterThanOrEqual(8);
    expect(anchor.right).toBeGreaterThanOrEqual(8);
    unmount();
  }
});

test('a very narrow viewport never forces a minimum menu width', () => {
  vi.stubGlobal('innerWidth', 180);
  vi.stubGlobal('innerHeight', 400);
  const { result } = openMenu(50, 320);
  expect(result.current.anchor!.maxWidth).toBeLessThanOrEqual(164);
});

test('a trigger near the top opens below instead of above the screen', () => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 300);
  const { result } = openMenu(91, 35);
  const anchor = result.current.anchor!;
  expect(anchor.top).toBe(69);
  expect(anchor.bottom).toBeUndefined();
  expect(anchor.maxHeight).toBeLessThanOrEqual(223);
});

test('keyboard and visual viewport scrolling keep an open menu in the visible area', () => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  const viewport = Object.assign(new EventTarget(), { width: 300, height: 350, offsetLeft: 30, offsetTop: 100 });
  vi.stubGlobal('visualViewport', viewport);
  const { result, unmount } = openMenu(91, 807);
  const check = () => {
    const a = result.current.anchor!;
    expect(390 - a.right).toBeLessThanOrEqual(322);
    expect(390 - a.right - a.maxWidth).toBeGreaterThanOrEqual(38);
    expect(844 - a.bottom!).toBeLessThanOrEqual(viewport.offsetTop + viewport.height - 8);
    expect(844 - a.bottom! - a.maxHeight).toBeGreaterThanOrEqual(viewport.offsetTop + 8);
  };
  check();
  viewport.height = 240;
  act(() => viewport.dispatchEvent(new Event('resize')));
  check();
  viewport.offsetTop = 180;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  check();
  unmount();
});

test('a child popup retains its anchor after the parent menu is hidden',()=>{
  vi.stubGlobal('innerWidth',390);
  vi.stubGlobal('innerHeight',844);
  const {result}=openMenu(200,500);
  const trigger=result.current.triggerRef.current!;
  trigger.getBoundingClientRect=()=>({left:50,right:200,top:500,bottom:530,width:150,height:30} as DOMRect);
  act(()=>result.current.updateAnchor());
  const before=result.current.anchor;
  trigger.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);
  act(()=>window.dispatchEvent(new Event('resize')));
  expect(result.current.anchor).toEqual(before);
});
