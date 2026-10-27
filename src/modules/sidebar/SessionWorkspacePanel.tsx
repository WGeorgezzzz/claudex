import { useTranslation } from 'react-i18next';
import { Pin, RefreshCw } from 'lucide-react';

import { SectionRow } from '@/modules/sidebar/SectionRow';
import { SessionMonitorBadge } from '@/shared/ui';
import { useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';
import { SessionInbox } from '@/modules/sidebar/modals/SessionInbox';

/** SidebarContent shows pinned chats; SessionInbox owns unread and attention filtering. */
export function SessionWorkspacePanel({onSelect}:{onSelect:(projectId:string|null,id:string,provider:string)=>void}) {
  const state=useSessionWorkspace();const {t}=useTranslation('sidebar');
  if(!state)return null;
  const rows=state.entries.filter(row=>row.pinnedAt!==null).sort((a,b)=>(b.pinnedAt??0)-(a.pinnedAt??0));
  return <section className="sidebar-session-workspace mx-2 mb-3 p-1" aria-label={t('workspace.title')}>
    <SessionInbox onSelect={onSelect}/>
    {rows.length>0&&<div className="mt-3 flex items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground"><Pin size={12}/>{t('workspace.pinned')}</div>}
    {state.error&&<div role="alert" className="flex items-center gap-1 px-2 py-1 text-xs text-destructive"><span>{t('workspace.loadFailed')}</span>
      <button aria-label={t('workspace.retry')} onClick={()=>void state.refresh()}><RefreshCw size={12}/></button></div>}
    <div className="max-h-52 overflow-y-auto">{rows.map(row=><SectionRow key={row.sessionId} target={{kind:'session',targetId:row.sessionId,title:row.title}}><a href={`/session/${encodeURIComponent(row.sessionId)}`}
      className="block rounded px-2 py-1.5 text-xs hover:bg-muted" onClick={event=>{
        if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
        event.preventDefault();onSelect(row.projectId,row.sessionId,row.provider);
      }}>
      <span className={`block truncate ${row.unread?'font-semibold':'font-normal'}`}>{row.unread?'● ':''}<SessionMonitorBadge sessionId={row.sessionId}/>{row.title}</span>
      <span className="block truncate text-[10px] text-muted-foreground">{row.approvalCount>0?t('workspace.waitingApproval',{count:row.approvalCount}):row.blockedCount>0?t('workspace.blocked',{count:row.blockedCount}):row.queuePaused&&row.queuedCount>0?t('workspace.paused',{count:row.queuedCount}):row.projectPath||row.provider}</span>
    </a></SectionRow>)}</div>
  </section>;
}
