import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ListOrdered, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { QueuedConversationMessage, QueuedDraft, QueuedMessageAttempt, QueueMessageChange } from '@/shared/types';

type MessageQueuePanelProps = {
  items: QueuedConversationMessage[];
  error: string;
  update: (item: QueuedConversationMessage, body: QueueMessageChange) => Promise<void>;
  attempts?: (id: string) => Promise<QueuedMessageAttempt[]>;
  paused?: boolean | null;
  setPaused?: (paused: boolean) => Promise<void>;
  retryLive?: (item: QueuedConversationMessage) => Promise<unknown>;
  convertLive?: (item: QueuedConversationMessage) => Promise<void>;
  queuedDraft?: QueuedDraft | null;
  onEditQueuedDraft?: () => void;
  onDeleteQueuedDraft?: () => void;
};

/** ChatComposer hosts one compact tray for durable pending messages and legacy local drafts. */
export function MessageQueuePanel({items, error, update, attempts, paused = null, setPaused,
  retryLive, convertLive, queuedDraft, onEditQueuedDraft, onDeleteQueuedDraft}: MessageQueuePanelProps) {
  const {t} = useTranslation('chat');
  // The tray opens on demand or when a newly failed message needs recovery.
  const [expanded, setExpanded] = useState(false);
  // Capture the original revision, so polling cannot silently overwrite a concurrent edit.
  const [editing, setEditing] = useState<{item: QueuedConversationMessage; text: string; error: string} | null>(null);
  // Only one mutation runs at a time; recovery buttons remain visible while it completes.
  const [pending, setPending] = useState(false);
  // A row exposes only one touch target until its action disclosure is opened.
  const [menu, setMenu] = useState<string | null>(null);
  // Receipts are fetched only when requested inside the secondary history disclosure.
  const [receipts, setReceipts] = useState<{id: string; items: QueuedMessageAttempt[]; error?: string} | null>(null);
  // Local recovery failures must be visible even when the caller has no error hook.
  const [actionError, setActionError] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  const active = items.filter(item => ['queued', 'failed', 'interrupted'].includes(item.status));
  const failedSignature = active.filter(item => item.status !== 'queued').map(item => `${item.id}:${item.revision}`).join(',');
  useEffect(() => {
    if (failedSignature || error) {
      setExpanded(true);
      requestAnimationFrame(() => sectionRef.current?.querySelector('[data-queue-failed]')?.scrollIntoView?.({block: 'nearest'}));
    }
  }, [failedSignature, error]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && (event.target as Element)?.closest?.('[data-queue-menu]')) return;
      setMenu(null);
      if (event.type === 'keydown') sectionRef.current?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${menu}"]`)?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close);};
  }, [menu]);
  const ordinary = active.filter(item => item.delivery_mode !== 'live');
  const canMove = (item: QueuedConversationMessage, direction: number) => ordinary[ordinary.findIndex(row => row.id === item.id) + direction]?.status === 'queued';
  const perform = async (action: () => Promise<unknown>) => {
    setPending(true); setActionError('');
    try {await action(); setMenu(null);} catch (reason) {setActionError(reason instanceof Error ? reason.message : String(reason));}
    finally {setPending(false);}
  };
  const count = active.length + (queuedDraft ? 1 : 0);
  if (!count && !error && !paused && !editing && !actionError) return null;
  const preview = active[0]?.content || queuedDraft?.content || (count ? t('queue.attachmentsOnly') : '');
  const buttonClass = 'min-h-10 min-w-10 rounded-md px-2 text-xs hover:bg-muted disabled:opacity-40';
  return <section ref={sectionRef} aria-label={t('queue.title')} className="queue-panel mx-auto mb-2 w-full min-w-0 max-w-[54.25rem] rounded-xl bg-muted/20 text-xs ring-1 ring-inset ring-border">
    <button type="button" aria-expanded={expanded} aria-label={t(expanded ? 'queue.collapse' : 'queue.expand')}
      onClick={() => setExpanded(value => !value)} className="flex h-10 w-full min-w-0 items-center gap-2 px-3 text-left">
      <ListOrdered size={14} className="shrink-0"/><span className="shrink-0 font-medium">{t('queue.title')} {count}</span>
      {paused && <span className="shrink-0 text-amber-700 dark:text-amber-300">{t('queue.paused')}</span>}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview && `· ${preview}`}</span>
      {expanded ? <ChevronUp size={16} className="shrink-0"/> : <ChevronDown size={16} className="shrink-0"/>}
    </button>
    {expanded && <div className="max-h-[40vh] overflow-y-auto overscroll-contain border-t border-border/50">
      {paused !== null && setPaused && <div className="flex min-h-10 items-center justify-between gap-2 px-3">
        <span className="text-muted-foreground">{paused ? t('queue.paused') : t('queue.pauseHint')}</span>
        <button type="button" disabled={pending} className={`${buttonClass} shrink-0`} onClick={() => void perform(() => setPaused(!paused))}>{t(paused ? 'queue.resume' : 'queue.pause')}</button>
      </div>}
      {(error || actionError) && <p role="alert" className="px-3 py-2 text-destructive">{actionError || error}</p>}
      {active.map(item => <div key={item.id} data-queue-failed={item.status !== 'queued' || undefined} className="border-t border-border/50 px-3 py-1">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1 py-1">
            <span className="text-muted-foreground">{item.delivery_mode === 'live' ? t('liveInput.unconfirmed') : t(`queue.status.${item.status}`)}</span>
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words">{item.content || t('queue.attachmentsOnly')}</p>
          </div>
          <div className="shrink-0" data-queue-menu>
            <button type="button" data-menu-trigger={item.id} disabled={pending} aria-expanded={menu === item.id} aria-label={t('queue.more')}
              className={buttonClass} onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreHorizontal size={18}/></button>
          </div>
        </div>
        {menu === item.id && <div data-queue-menu role="group" aria-label={t('queue.more')} className="flex flex-wrap gap-1 rounded-lg border border-border bg-popover p-1">
          {item.status === 'queued' && <>
            <button type="button" disabled={pending} className={buttonClass} onClick={() => {setEditing({item, text: item.content, error: ''}); setMenu(null);}}>{t('queue.edit')}</button>
            {item.delivery_mode !== 'live' && <>
              <button type="button" disabled={pending || !canMove(item, -1)} className={buttonClass} onClick={() => void perform(() => update(item, {action: 'move-up'}))}>{t('queue.moveUp')}</button>
              <button type="button" disabled={pending || !canMove(item, 1)} className={buttonClass} onClick={() => void perform(() => update(item, {action: 'move-down'}))}>{t('queue.moveDown')}</button>
            </>}
          </>}
          <button type="button" disabled={pending} className={`${buttonClass} text-destructive`} onClick={() => void perform(() => update(item, {action: 'cancel'}))}>{t('queue.cancel')}</button>
        </div>}
        {item.error && <p className="mt-1 break-words text-destructive">{item.error}</p>}
        {item.status !== 'queued' && <div className="mt-1">
          <p className="text-destructive">{t(item.delivery_mode === 'live' ? 'liveInput.unconfirmed' : 'queue.blocked')}</p>
          <div className="flex flex-wrap gap-1">
            {item.delivery_mode === 'live' ? <>
              <button type="button" disabled={pending || !retryLive} className={buttonClass} onClick={() => void perform(() => retryLive!(item))}>{t('liveInput.retryLive')}</button>
              <button type="button" disabled={pending || !convertLive} className={buttonClass} onClick={() => void perform(() => convertLive!(item))}>{t('liveInput.convert')}</button>
            </> : <button type="button" disabled={pending} className={buttonClass} onClick={() => void perform(() => update(item, {action: 'retry'}))}>{t('queue.retry')}</button>}
            <button type="button" disabled={pending} className={`${buttonClass} text-destructive`} onClick={() => void perform(() => update(item, {action: 'cancel'}))}>{t(item.delivery_mode === 'live' ? 'queue.delete' : 'queue.cancel')}</button>
          </div>
        </div>}
      </div>)}
      {queuedDraft && <div className="border-t border-border/50 px-3 py-2">
        <div className="flex items-center gap-2"><span className="min-w-0 flex-1 text-muted-foreground">{t('queue.local')}</span>
          <button type="button" className={buttonClass} aria-label={t('queue.more')} aria-expanded={menu === 'local'} onClick={() => setMenu(menu === 'local' ? null : 'local')} data-queue-menu><MoreHorizontal size={18}/></button></div>
        <p className="line-clamp-2 break-words">{queuedDraft.content || t('queue.attachmentsOnly')}</p>
        {menu === 'local' && <div data-queue-menu className="flex gap-1">
          <button type="button" className={buttonClass} onClick={onEditQueuedDraft}>{t('queue.edit')}</button>
          <button type="button" className={buttonClass} onClick={onDeleteQueuedDraft}>{t('queue.cancel')}</button>
        </div>}
      </div>}
      {editing && <form className="border-t border-border px-3 py-2" onSubmit={event => {
        event.preventDefault();
        void perform(async () => {
          try {await update(editing.item, {content: editing.text}); setEditing(null);}
          catch (reason) {setEditing(value => value && {...value, error: t('queue.editConflict')}); throw reason;}
        });
      }}>
        {(editing.error || !active.some(item => item.id === editing.item.id && item.status === 'queued')) && <p role="alert" className="mb-1 text-destructive">{editing.error || t('queue.editConflict')}</p>}
        <textarea autoFocus aria-label={t('queue.edit')} className="w-full rounded border bg-background p-2 text-sm" rows={3}
          value={editing.text} onChange={event => setEditing({...editing, text: event.target.value})}/>
        <button type="submit" disabled={pending || !editing.text.trim() || !active.some(item => item.id === editing.item.id && item.status === 'queued')} className={buttonClass}>{t('queue.save')}</button>
        <button type="button" disabled={pending} className={buttonClass} onClick={() => setEditing(null)}>{t('queue.dismissEdit')}</button>
      </form>}
      {!!items.length && <details className="border-t border-border/50 px-3">
        <summary className="min-h-10 cursor-pointer py-3 text-muted-foreground">{t('queue.history')} · {items.length}</summary>
        {items.map(item => <div key={item.id} className="flex min-w-0 items-center gap-2 py-1">
          <span className="shrink-0">{t(`queue.status.${item.status}`)}</span><span className="min-w-0 flex-1 truncate">{item.content || t('queue.attachmentsOnly')}</span>
          {attempts && item.attempt_count > 0 && <button type="button" className={`${buttonClass} shrink-0 underline`} onClick={() => void attempts(item.id)
            .then(values => setReceipts({id: item.id, items: values}))
            .catch(reason => setReceipts({id: item.id, items: [], error: String(reason.message)}))}>{t('queue.attempts')}</button>}
        </div>)}
        {receipts && <div className="border-t py-2">
          {receipts.error && <p role="alert">{receipts.error}</p>}
          <ul>{receipts.items.map(receipt => <li key={receipt.id} className="mt-1 whitespace-pre-wrap break-words">
            #{receipt.attempt} · {t(`queue.status.${receipt.status}`)} · {new Date(receipt.started_at).toLocaleString()}
            {receipt.error && <p className="text-destructive">{receipt.error}</p>}
          </li>)}</ul>
        </div>}
      </details>}
    </div>}
  </section>;
}
