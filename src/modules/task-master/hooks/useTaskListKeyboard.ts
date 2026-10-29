import { useEffect, useRef } from 'react';

/** Used only by the intelligent task list; shortcuts act on visible rows and existing actions. */
export function useTaskListKeyboard(blocked: boolean) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const list = listRef.current;
      if (blocked || !list || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]')) return;
      // Nested controls retain their own keyboard behavior.
      if (target?.closest('button, a') || (target && target !== document.body && !list.contains(target))) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-task-intelligence-id]'));
      if (!rows.length) return;
      const current = target?.closest<HTMLElement>('[data-task-intelligence-id]');
      const index = rows.findIndex(row => row === current);
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const next = rows[index < 0 ? (event.key === 'j' ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)))];
        next.focus({ preventScroll: true });
        next.scrollIntoView?.({ block: 'nearest' });
      } else if (event.key === 'x' && current && !event.repeat) {
        event.preventDefault();
        current.querySelector<HTMLButtonElement>('button[data-complete-task]')?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blocked]);
  return listRef;
}
