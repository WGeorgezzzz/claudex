import { useState } from 'react';
import { ArrowDown, ArrowUp, ListOrdered, Pause, Play, RotateCcw, X, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { QueuedConversationMessage, QueuedMessageAttempt, QueueMessageChange } from '@/shared/types';

type MessageQueuePanelProps = {
  items: QueuedConversationMessage[];
  error: string;
  update: (item:QueuedConversationMessage,body:QueueMessageChange)=>Promise<void>;
  attempts?: (id:string)=>Promise<QueuedMessageAttempt[]>;
  paused?: boolean|null;
  setPaused?: (paused:boolean)=>Promise<void>;
};

/** ChatInterface displays pending FIFO work independently from editable composer drafts. */
export function MessageQueuePanel({items,error,update,attempts,paused=null,setPaused}:MessageQueuePanelProps) {
  const {t}=useTranslation('chat');
  // Editing is local until the revision-checked server update is acknowledged.
  const [editing,setEditing]=useState<{id:string;text:string}|null>(null);
  // Keep a single explicit edit/action in flight to avoid accidental double clicks.
  const [pending,setPending]=useState(false);
  // Keep the requested immutable receipts separate from the live queue summary.
  const [receipts,setReceipts]=useState<{id:string;items:QueuedMessageAttempt[];error?:string}|null>(null);
  const active=items.filter(item=>['queued','running','failed','interrupted'].includes(item.status));
  const ordinary=active.filter(item=>item.delivery_mode!=='live');
  const canMove=(item:QueuedConversationMessage,direction:number)=>{
    const neighbor=ordinary[ordinary.findIndex(row=>row.id===item.id)+direction];
    return neighbor?.status==='queued';
  };
  const perform=async(item:QueuedConversationMessage,body:QueueMessageChange)=>{
    setPending(true);
    try {await update(item,body);setEditing(null);} catch {/* The hook retains the visible error and edit text. */}
    finally {setPending(false);}
  };
  if (!items.length && !error && !paused) return null;
  const needsAttention=active.length>0||Boolean(error)||Boolean(paused);
  return <section aria-label={t('queue.title')} className={`queue-panel mx-auto mb-2 w-[calc(100%-2rem)] max-w-[52.25rem] rounded-xl text-xs ${needsAttention?'border border-border bg-muted/20':'text-muted-foreground'}`}>
    {needsAttention&&<div className="flex items-center gap-2 px-3 py-2"><ListOrdered size={14}/><span className="font-medium">{t('queue.title')}</span>
      <span className="text-muted-foreground">{active.length}</span>
      {paused!==null&&setPaused&&<button type="button" disabled={pending} className="ml-auto flex items-center gap-1 rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
        title={t('queue.pauseHint')} aria-label={t(paused?'queue.resume':'queue.pause')} onClick={()=>{
          setPending(true);void setPaused(!paused).catch(()=>{}).finally(()=>setPending(false));
        }}>{paused?<Play size={13}/>:<Pause size={13}/>} {t(paused?'queue.resume':'queue.pause')}</button>}
    </div>}
    {paused&&<p role="status" className="px-3 pb-2 text-amber-700 dark:text-amber-300">{t('queue.pausedHint')}</p>}
    {error&&<p role="alert" className="px-3 pb-2 text-destructive">{error}</p>}
    <div className="max-h-44 overflow-y-auto">
      {active.map(item=><div key={item.id} className="border-t border-border/50 px-3 py-2">
        <div className="flex items-center gap-2"><span className="text-muted-foreground">{item.delivery_mode==='live'?`${t('liveInput.label')} · `:''}{t(item.delivery_mode==='live'&&item.status==='running'?'liveInput.delivered':`queue.status.${item.status}`)}</span>
          <span className="ml-auto flex gap-2">
            {paused!==null&&item.status==='queued'&&item.delivery_mode!=='live'&&<>
              <button disabled={pending||!canMove(item,-1)} aria-label={t('queue.moveUp')} title={t('queue.moveUp')} onClick={()=>void perform(item,{action:'move-up'})}><ArrowUp size={13}/></button>
              <button disabled={pending||!canMove(item,1)} aria-label={t('queue.moveDown')} title={t('queue.moveDown')} onClick={()=>void perform(item,{action:'move-down'})}><ArrowDown size={13}/></button>
            </>}
            {item.status==='queued'&&<button disabled={pending} aria-label={t('queue.edit')} onClick={()=>setEditing({id:item.id,text:item.content})}><Pencil size={13}/></button>}
            {['failed','interrupted'].includes(item.status)&&<button disabled={pending} aria-label={t(item.delivery_mode==='live'?'liveInput.retryQueued':'queue.retry')} title={t(item.delivery_mode==='live'?'liveInput.retryQueued':'queue.retry')} onClick={()=>void perform(item,{action:'retry'})}><RotateCcw size={13}/></button>}
            {item.status!=='running'&&<button disabled={pending} aria-label={t('queue.cancel')} onClick={()=>void perform(item,{action:'cancel'})}><X size={13}/></button>}
          </span></div>
        {editing?.id===item.id?<form onSubmit={event=>{event.preventDefault();void perform(item,{content:editing.text});}}>
          <textarea aria-label={t('queue.edit')} className="mt-2 w-full rounded border bg-background p-2" rows={3}
            value={editing.text} onChange={event=>setEditing({...editing,text:event.target.value})}/>
          <button type="submit" disabled={pending||!editing.text.trim()} className="mt-1 rounded border px-2 py-1">{t('queue.save')}</button>
        </form>:<p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words">{item.content||t('queue.attachmentsOnly')}</p>}
        {item.error&&<p className="mt-1 text-destructive">{item.error}</p>}
        {['failed','interrupted'].includes(item.status)&&<p className="mt-1 text-muted-foreground">{t(item.delivery_mode==='live'?'liveInput.unconfirmed':'queue.blocked')}</p>}
      </div>)}
    </div>
    {!!items.length&&<details className={`px-3 py-1.5 ${needsAttention?'border-t border-border/50':''}`}><summary className="cursor-pointer text-muted-foreground">{t('queue.history')} · {items.length}</summary>
      <div className="max-h-32 overflow-y-auto">{items.map(item=><div key={item.id} className="mt-2 flex gap-2">
        <span className="shrink-0">{t(`queue.status.${item.status}`)}</span><span className="truncate">{item.content||t('queue.attachmentsOnly')}</span>
        <span className="ml-auto shrink-0">×{item.attempt_count}</span>
        {attempts&&item.attempt_count>0&&<button className="shrink-0 underline" onClick={()=>void attempts(item.id)
          .then(values=>setReceipts({id:item.id,items:values}))
          .catch(reason=>setReceipts({id:item.id,items:[],error:String(reason.message)}))}>{t('queue.attempts')}</button>}
      </div>)}</div>
      {receipts&&<div className="mt-2 border-t pt-2">
        {receipts.error&&<p role="alert">{receipts.error}</p>}
        <ul>{receipts.items.map(receipt=><li key={receipt.id} className="mt-1 whitespace-pre-wrap break-words">
          #{receipt.attempt} · {t(`queue.status.${receipt.status}`)} · {new Date(receipt.started_at).toLocaleString()}
          {receipt.error&&<p className="text-destructive">{receipt.error}</p>}
        </li>)}</ul>
      </div>}
    </details>}
  </section>;
}
