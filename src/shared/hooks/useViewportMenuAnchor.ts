import { useCallback, useEffect, useRef, useState } from 'react';

import type { ViewportMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

/**
 * Used by chat menus and shared ActionMenu to keep their entire surface in
 * the visible viewport, including when a mobile keyboard resizes or pans it.
 */
export function useViewportMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
  placement: 'above' | 'below' = 'above',
  align: 'left' | 'right' = 'right',
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Nested popovers can outlive a hidden parent menu; retain their last visible
  // trigger geometry so keyboard resizing does not anchor them to a zero rect.
  const lastTriggerRectRef = useRef<DOMRect | null>(null);
  // Portal placement must follow the trigger and the visible viewport while open.
  const [anchor, setAnchor] = useState<ViewportMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const measuredRect = triggerRef.current?.getBoundingClientRect();
    if (!measuredRect) {
      return;
    }
    if (measuredRect.width > 0 || measuredRect.height > 0) lastTriggerRectRef.current = measuredRect;
    const rect = measuredRect.width === 0 && measuredRect.height === 0
      ? lastTriggerRectRef.current ?? measuredRect : measuredRect;

    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN;
    const top = (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN;
    const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN;
    const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - VIEWPORT_MARGIN;
    const maxWidth = Math.max(0, Math.min(preferredWidth, rightEdge - left));
    // Shift the whole menu right when its trigger is close to the left edge.
    const anchorRight = align === 'left' ? rect.left + maxWidth : rect.right;
    const right = window.innerWidth - Math.min(rightEdge, Math.max(left + maxWidth, anchorRight));
    const aboveEnd = Math.max(top, Math.min(bottomEdge, rect.top - MENU_GAP));
    const belowStart = Math.max(top, Math.min(bottomEdge, rect.bottom + MENU_GAP));
    const above = Math.max(0, aboveEnd - top);
    const below = Math.max(0, bottomEdge - belowStart);
    const openBelow = placement === 'below'
      ? below >= 160 || below > above
      : above < 160 && below > above;
    setAnchor({
      right,
      ...(openBelow ? { top: belowStart } : { bottom: window.innerHeight - aboveEnd }),
      maxHeight: openBelow ? below : above,
      maxWidth,
    });
  }, [preferredWidth, placement, align]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', updateAnchor);
    viewport?.addEventListener('scroll', updateAnchor);
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      viewport?.removeEventListener('resize', updateAnchor);
      viewport?.removeEventListener('scroll', updateAnchor);
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
