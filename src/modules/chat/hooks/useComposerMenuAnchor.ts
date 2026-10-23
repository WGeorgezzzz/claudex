import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

/**
 * Used by chat's model and permission menus to keep their entire surface in
 * the visible viewport, including when a mobile keyboard resizes or pans it.
 */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Portal placement must follow the trigger and the visible viewport while open.
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN;
    const top = (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN;
    const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN;
    const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - VIEWPORT_MARGIN;
    const maxWidth = Math.max(0, Math.min(preferredWidth, rightEdge - left));
    // Shift the whole menu right when its trigger is close to the left edge.
    const right = window.innerWidth - Math.min(rightEdge, Math.max(left + maxWidth, rect.right));
    const aboveEnd = Math.max(top, Math.min(bottomEdge, rect.top - MENU_GAP));
    const belowStart = Math.max(top, Math.min(bottomEdge, rect.bottom + MENU_GAP));
    const above = Math.max(0, aboveEnd - top);
    const below = Math.max(0, bottomEdge - belowStart);
    const openBelow = above < 160 && below > above;
    setAnchor({
      right,
      ...(openBelow ? { top: belowStart } : { bottom: window.innerHeight - aboveEnd }),
      maxHeight: openBelow ? below : above,
      maxWidth,
    });
  }, [preferredWidth]);

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
