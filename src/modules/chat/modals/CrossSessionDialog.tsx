import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare, X } from 'lucide-react';

import { api, readApiErrorMessage } from '@/shared/api';
import { Dialog, DialogContent } from '@/shared/ui';
import type { BridgeHistory, BridgeReceipt, BridgeSession, BridgeSessionPage } from '@/shared/types';

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json(); if (!response.ok) throw new Error(readApiErrorMessage(body) || `HTTP ${response.status}`); return body.data;
}

/** ChatInterface exposes cross-conversation context and explicit queued sends while preserving the source draft. */
export function CrossSessionDialog({ sourceSessionId, draft, onInsert }: { sourceSessionId: string; draft: string; onInsert: (text: string) => void }) {
  const { t } = useTranslation('chat');
  // Keep the source conversation mounted while the manager is open.
  const [open, setOpen] = useState(false);
  // Query the full server index, not just the loaded sidebar page.
  const [query, setQuery] = useState('');
  // Hold a bounded result page and its continuation cursor.
  const [page, setPage] = useState<BridgeSessionPage | null>(null);
  // A target is selected by stable identity, never by title alone.
  const [target, setTarget] = useState<BridgeSession | null>(null);
  // Preview only user/assistant text before quoting it into the source draft.
  const [history, setHistory] = useState<BridgeHistory | null>(null);
  // Editing the forwarded message must not overwrite the main composer.
  const [content, setContent] = useState('');
  // Preserve and refresh the last dispatch receipt independently of target selection.
  const [receipt, setReceipt] = useState<BridgeReceipt | null>(null);
  // Retain errors and the draft after uncertain network outcomes.
  const [error, setError] = useState('');
  // Serialize reads/sends and suppress duplicate clicks.
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0); const writing = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const seq = ++sequence.current;
    const timer = setTimeout(() => { void api.sessionBridge.list(query).then(unwrap<BridgeSessionPage>).then(value => { if (seq === sequence.current) setPage(value); }).catch(reason => { if (seq === sequence.current) setError(String(reason)); }); }, 200);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [open, query]);
  useEffect(() => {
    if (!open || !receipt || !['queued', 'running'].includes(receipt.status)) return;
    let live = true;
    const timer = setInterval(() => { void api.sessionBridge.status(sourceSessionId, receipt.id).then(unwrap<BridgeReceipt>).then(value => { if (live) setReceipt(value); }).catch(reason => { if (live) setError(String(reason)); }); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [open, receipt?.id, receipt?.status, sourceSessionId]);
  const read = async (session: BridgeSession, offset = 0) => {
    if (writing.current) return; writing.current = true; setBusy(true); setError(''); setTarget(session);
    if (!offset) setHistory(null);
    try { const next = await unwrap<BridgeHistory>(await api.sessionBridge.read(session.sessionId, offset)); setHistory(previous => offset && previous?.sessionId === next.sessionId ? { ...next, messages: [...next.messages, ...previous.messages] } : next); }
    catch (reason) { setError(String(reason)); } finally { writing.current = false; setBusy(false); }
  };
  const send = async () => {
    if (!target || writing.current || !content.trim()) return;
    const key = JSON.stringify([sourceSessionId, target.sessionId, content]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    writing.current = true; setBusy(true); setError('');
    try { setReceipt(await unwrap<BridgeReceipt>(await api.sessionBridge.send({ sourceSessionId, sessionId: target.sessionId, requestId: request.current.id, content }))); setContent(''); request.current = null; }
    catch (reason) { setError(String(reason)); } finally { writing.current = false; setBusy(false); }
  };
  const more = () => { if (!page) return; const seq = sequence.current; void api.sessionBridge.list(query, page.sessions.length).then(unwrap<BridgeSessionPage>).then(next => { if (seq === sequence.current) setPage(previous => previous ? { ...next, offset: 0, sessions: [...previous.sessions, ...next.sessions] } : next); }).catch(reason => setError(String(reason))); };
  return <>
    <button type="button" onClick={() => { setContent(previous => previous || draft); setOpen(true); }} className="mx-4 mb-2 flex items-center gap-1 self-start rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><MessagesSquare size={14}/>{t('crossSession.title')}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-label={t('crossSession.title')} className="flex max-h-[88dvh] max-w-4xl flex-col overflow-hidden">
      <header className="flex items-center justify-between"><h2 className="font-semibold">{t('crossSession.title')}</h2><button aria-label={t('crossSession.close')} onClick={() => setOpen(false)}><X size={18}/></button></header>
      <p className="text-xs text-muted-foreground">{t('crossSession.description')}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <input aria-label={t('crossSession.search')} placeholder={t('crossSession.search')} value={query} onChange={event => setQuery(event.target.value)} maxLength={200} className="rounded border border-border bg-background px-3 py-2 text-sm"/>
      <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="max-h-64 space-y-1 overflow-y-auto sm:max-h-[50dvh]">{page?.sessions.filter(session => session.sessionId !== sourceSessionId).map(session => <button key={session.sessionId} type="button" disabled={busy} onClick={() => void read(session)} aria-pressed={target?.sessionId === session.sessionId} className={`block w-full rounded border border-border/50 p-2 text-left text-xs ${target?.sessionId === session.sessionId ? 'bg-muted' : 'hover:bg-muted/50'}`}><span className="block break-words font-medium">{session.title}</span><span className="block break-all text-[10px] text-muted-foreground">{session.projectPath} · {session.provider}</span></button>)}
          {page?.hasMore && <button type="button" onClick={more} className="p-2 text-xs text-muted-foreground">{t('crossSession.more')}</button>}
        </div>
        <div className="flex min-h-0 flex-col gap-2">{target ? <>
          <h3 className="text-sm font-medium">{target.title}</h3><div className="max-h-48 min-h-24 overflow-y-auto rounded border border-border p-2 text-xs">
            {history?.hasMore && <button disabled={busy} onClick={() => void read(target, history.offset + 20)} className="mb-2 text-muted-foreground hover:underline">{t('crossSession.earlier')}</button>}
            {history?.messages.map((message, index) => <div key={`${message.timestamp}-${index}`} className="mb-3"><strong>{message.role}</strong><p className="whitespace-pre-wrap break-words text-muted-foreground">{message.content}</p></div>)}
            {history?.messages.length === 0 && <p>{t('crossSession.empty')}</p>}
          </div>
          <button type="button" disabled={!history || busy} onClick={() => { if (!history) return; onInsert(`\n参考会话「${history.title}」（session_id=${history.sessionId}）：\n${history.messages.map(message => `${message.role}: ${message.content}`).join('\n\n').slice(0, 16000)}\n`); setOpen(false); }} className="rounded border border-border p-2 text-xs disabled:opacity-40">{t('crossSession.quote')}</button>
          <textarea aria-label={t('crossSession.message')} placeholder={t('crossSession.message')} value={content} onChange={event => setContent(event.target.value)} maxLength={20000} rows={3} className="rounded border border-border bg-background p-2 text-sm"/>
          <button type="button" disabled={busy || !content.trim() || !target.canSend} onClick={() => void send()} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-40">{t('crossSession.send')}</button>
          {!target.canSend && <p className="text-xs text-muted-foreground">{t('crossSession.readOnly')}</p>}
        </> : <p className="p-4 text-sm text-muted-foreground">{t('crossSession.select')}</p>}</div>
      </div>
      {receipt && <div role="status" className="rounded bg-muted p-3 text-xs"><p>{t('crossSession.receipt', { status: t(`crossSession.status.${receipt.status}`, { defaultValue: receipt.status }) })}</p>{receipt.error && <p className="mt-1 text-destructive">{receipt.error}</p>}<a href={`/session/${encodeURIComponent(receipt.sessionId)}`} className="mt-1 inline-block underline">{t('crossSession.openTarget')}</a></div>}
    </DialogContent></Dialog>
  </>;
}
