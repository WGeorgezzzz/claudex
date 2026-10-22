import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** ChatComposer keeps secondary actions in one disclosure without unmounting their dialogs. */
export function ComposerActions({children}:{children:ReactNode}) {
  const {t}=useTranslation('chat');
  const disclosure=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(disclosure.current&&!disclosure.current.contains(event.target as Node))disclosure.current.open=false;};
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  },[]);
  return <details ref={disclosure} className="composer-actions relative" onKeyDown={event=>{
    if(event.key==='Escape'&&disclosure.current?.open){event.stopPropagation();disclosure.current.open=false;disclosure.current.querySelector('summary')?.focus();}
  }}>
    <summary aria-label={t('ui.addContext')} title={t('ui.addContext')} className="workspace-icon-button cursor-pointer list-none"><Plus size={18}/></summary>
    <div role="group" aria-label={t('ui.moreActions')} className="composer-actions-menu absolute bottom-full left-0 z-50 mb-3 w-64 max-w-[calc(100vw-3rem)] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg">{children}</div>
  </details>;
}
