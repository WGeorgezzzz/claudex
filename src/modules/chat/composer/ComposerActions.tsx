import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useViewportMenuAnchor } from '@/shared/hooks/useViewportMenuAnchor';

/** ChatComposer keeps secondary actions inside the viewport without unmounting their dialogs. */
export function ComposerActions({children}:{children:ReactNode}) {
  const {t}=useTranslation('chat');
  // Only the menu surface is hidden; child-owned dialogs and drafts stay mounted.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useViewportMenuAnchor(isOpen, close, 256, 'above', 'left');
  return <div className="composer-actions">
    <button ref={triggerRef} type="button" aria-label={t('ui.addContext')} title={t('ui.addContext')}
      aria-expanded={isOpen} className="workspace-icon-button" onClick={() => {
        updateAnchor();
        setIsOpen(open => !open);
      }}><Plus size={18}/></button>
    {createPortal(<div ref={menuRef} role="group" aria-label={t('ui.moreActions')}
      className="composer-actions-menu fixed z-[100] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
      style={{ ...anchor, width: anchor?.maxWidth, display: isOpen && anchor ? undefined : 'none' }}>
      {children}
    </div>, document.body)}
  </div>;
}
