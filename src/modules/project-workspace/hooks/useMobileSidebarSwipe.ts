import { useEffect, useRef } from 'react';

type Swipe = { x: number; y: number; startedAt: number; horizontal: boolean };

/** ProjectSidebarRegion owns touch navigation independently of browser history. */
export function useMobileSidebarSwipe(isMobile: boolean, sidebarOpen: boolean, setSidebarOpen: (open: boolean) => void) {
  // Keep the trailing synthetic click from undoing a completed swipe after rerender.
  const trailingClick = useRef<{ x: number; y: number; until: number } | null>(null);

  useEffect(() => {
    if (!isMobile) return;
    let swipe: Swipe | null = null;

    const start = (event: TouchEvent) => {
      swipe = null;
      trailingClick.current = null;
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || !target.closest('.workspace-shell')) return;
      // Editing, code/terminal scrolling, open overlays and text selection own their gestures.
      if (target.closest('input, textarea, select, a, [contenteditable="true"], [role="slider"], [role="dialog"], [role="menu"], .xterm, .cm-editor, pre, code, [data-no-sidebar-swipe]')) return;
      if (!sidebarOpen && target.closest('button, [role="button"]')) return;
      if (window.getSelection()?.toString()) return;
      for (let element: Element | null = target; element && !element.classList.contains('workspace-shell'); element = element.parentElement) {
        if (element.scrollWidth > element.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(element).overflowX)) return;
      }
      const touch = event.touches[0];
      swipe = { x: touch.clientX, y: touch.clientY, startedAt: Date.now(), horizontal: false };
    };
    const move = (event: TouchEvent) => {
      if (!swipe) return;
      if (event.touches.length !== 1 || window.getSelection()?.toString()) { swipe = null; return; }
      const dx = event.touches[0].clientX - swipe.x;
      const dy = event.touches[0].clientY - swipe.y;
      if (!swipe.horizontal) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { swipe = null; return; }
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (sidebarOpen ? dx > 0 : dx < 0) { swipe = null; return; }
        swipe.horizontal = true;
      }
      if (event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const origin = swipe;
      swipe = null;
      if (!origin || !origin.horizontal || event.touches.length || event.changedTouches.length !== 1 || Date.now() - origin.startedAt > 800) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - origin.x;
      const dy = touch.clientY - origin.y;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5 || (sidebarOpen ? dx >= 0 : dx <= 0)) return;
      if (event.cancelable) event.preventDefault();
      trailingClick.current = { x: touch.clientX, y: touch.clientY, until: Date.now() + 400 };
      setSidebarOpen(!sidebarOpen);
    };
    const cancel = () => { swipe = null; };
    const click = (event: MouseEvent) => {
      const trailing = trailingClick.current;
      if (!trailing || event.detail === 0 || Date.now() > trailing.until || Math.hypot(event.clientX - trailing.x, event.clientY - trailing.y) > 32) return;
      trailingClick.current = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Capture also sees gestures beginning in sidebar rows that stop propagation.
    document.addEventListener('touchstart', start, { capture: true, passive: true });
    document.addEventListener('touchmove', move, { capture: true, passive: false });
    document.addEventListener('touchend', end, { capture: true, passive: false });
    document.addEventListener('touchcancel', cancel, true);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancel, true);
      document.removeEventListener('click', click, true);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);
}
