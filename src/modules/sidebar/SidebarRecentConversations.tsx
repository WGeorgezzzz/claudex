import { Fragment } from 'react';
import type { TFunction } from 'i18next';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/shared/ui';
import type { ProjectSession, RecentConversationListItem, SessionRowActions } from '@/shared/types';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { SessionRow } from '@/modules/sidebar/SessionRow';
import SessionOptions from '@/modules/sidebar/SessionOptions';

type SidebarRecentConversationsProps = {
  conversations:RecentConversationListItem[];total:number;hasMore:boolean;isLoading:boolean;isLoadingMore:boolean;hasError:boolean;
  selectedSession:ProjectSession|null;currentTime:Date;sessionActions:SessionRowActions;
  onConversationSelect:(projectId:string|null,sessionId:string,provider:string)=>void;
  onLoadMore:()=>void;onRetry:()=>void;t:TFunction;
};

/** SidebarContent displays recent search results using the same row and menus as projects. */
export default function SidebarRecentConversations(props:SidebarRecentConversationsProps) {
  const {conversations,sessionActions:actions,t}=props;
  const claude=conversations.filter(row=>row.provider==='claude');
  const ordered=[...claude,...conversations.filter(row=>row.provider!=='claude')];
  if(props.isLoading&&!conversations.length)return <div aria-label="Loading recent conversations" className="space-y-1 px-2">{Array.from({length:8},(_,i)=><div key={i} className="h-9 animate-pulse rounded-md bg-muted"/>)}</div>;
  if(props.hasError&&!conversations.length)return <div className="px-4 py-10 text-center"><MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground"/><p className="text-sm">{t('recent.loadFailed','Could not load recent conversations')}</p><Button variant="ghost" size="sm" onClick={props.onRetry}>{t('buttons.retry',{ns:'common',defaultValue:'Try again'})}</Button></div>;
  if(!conversations.length)return <div className="px-4 py-10 text-center"><MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground"/><p className="text-sm">{t('recent.emptyTitle','No conversations yet')}</p><p className="mt-1 text-xs text-muted-foreground">{t('recent.emptyDescription','Your most recently updated conversations will appear here.')}</p></div>;
  return <div className="px-1" data-testid="recent-conversations-list">
    <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5"><span className="text-[11px] font-medium text-muted-foreground">{t('recent.title','Recent conversations')}</span><span className="text-[10px] text-muted-foreground">{props.total}</span></div>
    {ordered.map((row,index)=>{
      const background=actions.backgroundSessionIds.has(row.sessionId),processing=actions.activeSessions.has(row.sessionId)&&!background;
      const rename=actions.activeRename?.target==='session'&&actions.activeRename.id===row.sessionId?actions.activeRename:null;
      const age=formatCompactAge(row.lastActivity,props.currentTime);
      return <Fragment key={row.sessionId}>
        {(index===0||index===claude.length)&&<h3 className="px-2 pb-1 pt-3 text-[11px] font-semibold text-muted-foreground" data-provider-group={row.provider==='claude'?'claude':'other'}>{row.provider==='claude'?'Claude':t('sessions.otherProviders','Other chats')}</h3>}
        <div data-testid="recent-conversation-row"><SessionRow sessionId={row.sessionId} title={row.sessionTitle} provider={row.provider} selected={props.selectedSession?.id===row.sessionId}
          processing={processing} background={background} attention={actions.attentionSessionIds.has(row.sessionId)} t={t}
          onSelect={()=>props.onConversationSelect(row.projectId,row.sessionId,row.provider)}
          subtitle={<>{row.projectDisplayName}{!processing&&!background&&age&&<> · <time dateTime={row.lastActivity??undefined}>{age}</time></>}</>}
          options={<SessionOptions sessionId={row.sessionId} sessionName={row.sessionTitle} provider={row.provider} projectId={row.projectId} isProcessing={processing} hasBackgroundWork={background}
            isEditing={!!rename} renameDraft={rename?.draft??''} onRenameDraftChange={actions.onRenameDraftChange} onStartEditingSession={actions.onStartEditingSession}
            onCancelEditingSession={actions.onCancelEditingSession} onSaveEditingSession={actions.onSaveEditingSession} onDeleteSession={actions.onDeleteSession}
            onFork={actions.onForkSession?()=>actions.onForkSession?.({id:row.sessionId,summary:row.sessionTitle,__provider:row.provider,__projectId:row.projectId??undefined}):undefined} t={t}/>}/></div>
      </Fragment>;
    })}
    {props.hasMore&&<Button variant="ghost" size="sm" className="mt-1 h-8 w-full text-xs text-muted-foreground" onClick={props.onLoadMore} disabled={props.isLoadingMore}>{props.isLoadingMore?t('recent.loadingMore','Loading more...'):t('recent.loadMore','Load older conversations')}</Button>}
  </div>;
}
