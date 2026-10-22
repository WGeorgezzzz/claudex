import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Mail, Pin, RefreshCw } from 'lucide-react';
import { useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';

/** SidebarContent places pinned, unread and actionable conversations above its existing project/search views. */
export function SessionWorkspacePanel({onSelect}:{onSelect:(projectId:string|null,id:string,provider:string)=>void}) {
  const state=useSessionWorkspace();const {t}=useTranslation('sidebar');
  // The panel's local filter changes organization only; it never switches the active conversation.
  const [mode,setMode]=useState<'pinned'|'unread'|'attention'>('pinned');
  if(!state)return null;
  const filters={pinned:state.entries.filter(row=>row.pinnedAt!==null),unread:state.entries.filter(row=>row.unread),
    attention:state.entries.filter(row=>row.blockedCount>0||row.approvalCount>0||(row.queuePaused&&row.queuedCount>0))};
  const rows=[...filters[mode]].sort((a,b)=>mode==='pinned'?(b.pinnedAt??0)-(a.pinnedAt??0):String(b.lastActivityAt??'').localeCompare(String(a.lastActivityAt??'')));
  return <section className="mx-2 mb-2 rounded-lg border border-border/60 p-1" aria-label={t('workspace.title')}>
    <div className="flex gap-1">{(['pinned','unread','attention'] as const).map(key=>{
      const Icon=key==='pinned'?Pin:key==='unread'?Mail:Bell;
      return <button key={key} type="button" aria-pressed={mode===key} aria-label={t(`workspace.${key}`)}
        className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1 py-1.5 text-[11px] ${mode===key?'bg-muted text-foreground':'text-muted-foreground hover:bg-muted/60'}`}
        onClick={()=>setMode(key)}><Icon size={12}/>{t(`workspace.${key}`)}{filters[key].length>0&&<span>{filters[key].length}</span>}</button>;
    })}</div>
    {state.error&&<div role="alert" className="flex items-center gap-1 px-2 py-1 text-xs text-destructive"><span>{t('workspace.loadFailed')}</span>
      <button aria-label={t('workspace.retry')} onClick={()=>void state.refresh()}><RefreshCw size={12}/></button></div>}
    {state.ready&&rows.length===0&&<p className="px-2 py-2 text-[11px] text-muted-foreground">{t(`workspace.empty.${mode}`)}</p>}
    <div className="max-h-52 overflow-y-auto">{rows.map(row=><a key={row.sessionId} href={`/session/${encodeURIComponent(row.sessionId)}`}
      className="block rounded px-2 py-1.5 text-xs hover:bg-muted" onClick={event=>{
        if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
        event.preventDefault();onSelect(row.projectId,row.sessionId,row.provider);
      }}>
      <span className={`block truncate ${row.unread?'font-semibold':'font-normal'}`}>{row.unread?'● ':''}{row.title}</span>
      <span className="block truncate text-[10px] text-muted-foreground">{row.approvalCount>0?t('workspace.waitingApproval',{count:row.approvalCount}):row.blockedCount>0?t('workspace.blocked',{count:row.blockedCount}):row.queuePaused&&row.queuedCount>0?t('workspace.paused',{count:row.queuedCount}):row.projectPath||row.provider}</span>
    </a>)}</div>
  </section>;
}
