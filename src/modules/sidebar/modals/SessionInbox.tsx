import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, Mail, MailOpen, Pin, RefreshCw, X } from 'lucide-react';

import { Dialog, DialogContent } from '@/shared/ui';
import type { SessionWorkspaceChange, SessionWorkspaceEntry } from '@/shared/types';
import { useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';

type InboxFilter = 'all' | 'unread' | 'attention' | 'pinned';
const needsAttention = (row: SessionWorkspaceEntry) => row.approvalCount > 0 || row.blockedCount > 0 || (row.queuePaused && row.queuedCount > 0);

/** SessionWorkspacePanel opens a cross-project inbox using its existing polling owner. */
export function SessionInbox({ onSelect }: { onSelect: (projectId: string | null, id: string, provider: string) => void }) {
  const state = useSessionWorkspace();
  const { t, i18n } = useTranslation('sidebar');
  // Opening the inbox must preserve the underlying conversation and composer draft.
  const [open, setOpen] = useState(false);
  // Filters operate only on inbox entries, never on the current project selection.
  const [filter, setFilter] = useState<InboxFilter>('all');
  // Search is local to titles, paths and provider labels in the server snapshot.
  const [query, setQuery] = useState('');
  // Serialize metadata writes so fast repeated clicks cannot submit duplicate batches.
  const [busy, setBusy] = useState(false);
  // Batch failures remain visible even if a later item succeeds or polling refreshes.
  const [failure, setFailure] = useState('');
  const writing = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  if (!state?.ready) return null;

  const entries = state.entries.filter(row => row.unread || row.pinnedAt !== null || needsAttention(row) || row.queuedCount > 0 || row.runningCount > 0);
  const counts = {
    all: entries.length,
    unread: entries.filter(row => row.unread).length,
    attention: entries.filter(needsAttention).length,
    pinned: entries.filter(row => row.pinnedAt !== null).length,
  };
  const needle = query.trim().toLocaleLowerCase();
  const rows = entries.filter(row => (filter === 'all' || (filter === 'unread' ? row.unread : filter === 'pinned' ? row.pinnedAt !== null : needsAttention(row)))
    && `${row.title}\n${row.projectPath ?? ''}\n${row.provider}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || Number(b.unread) - Number(a.unread)
      || String(b.lastActivityAt ?? '').localeCompare(String(a.lastActivityAt ?? '')) || a.sessionId.localeCompare(b.sessionId));
  const unread = rows.filter(row => row.unread);
  const write = async (changes: { row: SessionWorkspaceEntry; input: SessionWorkspaceChange }[]) => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setFailure('');
    let failed = 0;
    try {
      // Each read acknowledgement is bounded to the snapshot clicked by the user.
      // New completions arriving during this batch remain unread on the server.
      for (const { row, input } of changes) {
        try { await state.change(row.sessionId, input); } catch { failed++; }
      }
      if (failed) setFailure(t('inbox.writeFailed', { count: failed }));
    } finally { writing.current = false; setBusy(false); }
  };

  return <>
    <button type="button" onClick={() => setOpen(true)} className="mt-1 flex w-full items-center justify-between rounded px-2 py-2 text-xs text-muted-foreground hover:bg-muted">
      <span className="flex items-center gap-2"><Inbox size={14}/>{t('inbox.title')}</span><span>{counts.unread + counts.attention > 0 ? entries.filter(row => row.unread || needsAttention(row)).length : ''}</span>
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent initialFocusRef={searchRef} aria-label={t('inbox.title')} className="flex max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div><h2 className="text-base font-semibold">{t('inbox.title')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('inbox.description')}</p></div>
          <button type="button" aria-label={t('inbox.close')} onClick={() => setOpen(false)} className="rounded p-1 hover:bg-muted"><X size={18}/></button>
        </header>
        <div className="space-y-3 border-b border-border px-5 py-3">
          <div className="flex flex-wrap gap-1">{(['all', 'unread', 'attention', 'pinned'] as const).map(key => <button key={key} type="button" aria-pressed={filter === key}
            onClick={() => setFilter(key)} className={`rounded-md px-3 py-1.5 text-xs ${filter === key ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}>
            {t(`inbox.filters.${key}`)} <span>{counts[key]}</span>
          </button>)}</div>
          <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('inbox.search')} aria-label={t('inbox.search')}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"/>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span role="status">{t('inbox.count', { count: rows.length })}</span>
            <div className="flex items-center gap-3">
              <button type="button" disabled={busy || unread.length === 0} onClick={() => void write(unread.map(row => ({ row, input: { unread: false, readThrough: row.lastActivityAt } })))} className="hover:underline disabled:opacity-40">{t('inbox.markVisibleRead', { count: unread.length })}</button>
              <button type="button" aria-label={t('workspace.retry')} onClick={() => void state.refresh()} className="rounded p-1 hover:bg-muted"><RefreshCw size={14}/></button>
            </div>
          </div>
          {(failure || state.error) && <p role="alert" className="text-xs text-destructive">{failure || t('workspace.loadFailed')}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-busy={busy}>
          {rows.length === 0 && <p className="px-2 py-12 text-center text-sm text-muted-foreground">{t('inbox.empty')}</p>}
          {rows.map(row => {
            const timestamp = row.lastActivityAt ? Date.parse(row.lastActivityAt) : NaN;
            return <article key={row.sessionId} aria-label={row.title} className="flex items-start gap-2 rounded-lg border-b border-border/50 px-2 py-3 hover:bg-muted/40">
              <a href={`/session/${encodeURIComponent(row.sessionId)}`} className="min-w-0 flex-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={event => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); setOpen(false); onSelect(row.projectId, row.sessionId, row.provider);
              }}>
                <div className={`break-words text-sm ${row.unread ? 'font-semibold' : ''}`}>{row.unread && <span className="mr-1 text-primary" aria-label={t('workspace.unread')}>●</span>}{row.title}</div>
                <p className="mt-1 break-all text-xs text-muted-foreground">{row.projectPath || t('inbox.noProject')} · {row.provider}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {row.approvalCount > 0 && <span className="text-amber-600 dark:text-amber-400">{t('workspace.waitingApproval', { count: row.approvalCount })}</span>}
                  {row.blockedCount > 0 && <span className="text-destructive">{t('workspace.blocked', { count: row.blockedCount })}</span>}
                  {row.queuePaused && row.queuedCount > 0 && <span>{t('workspace.paused', { count: row.queuedCount })}</span>}
                  {!row.queuePaused && row.queuedCount > 0 && <span>{t('inbox.queued', { count: row.queuedCount })}</span>}
                  {row.runningCount > 0 && <span>{t('inbox.running', { count: row.runningCount })}</span>}
                  {Number.isFinite(timestamp) && <time dateTime={row.lastActivityAt!}>{new Date(timestamp).toLocaleString(i18n.resolvedLanguage, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
                </div>
              </a>
              <div className="flex shrink-0 gap-1">
                <button type="button" disabled={busy} aria-label={t(row.unread ? 'inbox.markRead' : 'inbox.markUnread', { title: row.title })}
                  onClick={() => void write([{ row, input: row.unread ? { unread: false, readThrough: row.lastActivityAt } : { unread: true } }])} className="rounded p-2 text-muted-foreground hover:bg-muted disabled:opacity-40">{row.unread ? <MailOpen size={15}/> : <Mail size={15}/>}</button>
                <button type="button" disabled={busy} aria-pressed={row.pinnedAt !== null} aria-label={t(row.pinnedAt !== null ? 'inbox.unpin' : 'inbox.pin', { title: row.title })}
                  onClick={() => void write([{ row, input: { pinned: row.pinnedAt === null } }])} className={`rounded p-2 hover:bg-muted disabled:opacity-40 ${row.pinnedAt !== null ? 'text-primary' : 'text-muted-foreground'}`}><Pin size={15}/></button>
              </div>
            </article>;
          })}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
