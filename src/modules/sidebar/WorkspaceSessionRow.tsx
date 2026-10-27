import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Mail, MailOpen, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { SessionRow } from '@/modules/sidebar/SessionRow';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import { useSessionRowActions } from '@/modules/sidebar/context/SessionRowActionsContext';
import { useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';
import { useWorkspaceSections } from '@/modules/sidebar/context/WorkspaceSectionsContext';
import { ActionMenu } from '@/shared/ui';
import type { LLMProvider } from '@/shared/types';

/** Pinned, section and inbox entries use the same session row and action owner as project lists. */
export function WorkspaceSessionRow({id,title,provider,projectId,onSelect,selected,subtitle}:{id:string;title:string;provider:string;projectId:string|null;onSelect:()=>void;selected?:boolean;subtitle?:ReactNode}) {
  const {t}=useTranslation('sidebar'),actions=useSessionRowActions(),workspace=useSessionWorkspace(),sections=useWorkspaceSections();
  const row=workspace?.byId.get(id),rename=actions?.activeRename;
  const editing=rename?.target==='session'&&rename.id===id;
  const processing=actions?.activeSessions.has(id)??!!row?.runningCount;
  const background=actions?.backgroundSessionIds.has(id)??false;
  return <SessionRow sessionId={id} title={title} provider={provider} selected={selected} processing={processing&&!background} background={background}
    attention={!!row&&(row.approvalCount>0||row.blockedCount>0||(row.queuePaused&&row.queuedCount>0))} subtitle={subtitle} t={t} onSelect={onSelect}
    options={actions?<SessionOptions sessionId={id} sessionName={title} provider={provider as LLMProvider} projectId={projectId}
      isProcessing={processing&&!background} isEditing={editing} renameDraft={editing?rename.draft:''}
      onRenameDraftChange={actions.onRenameDraftChange} onStartEditingSession={actions.onStartEditingSession} onCancelEditingSession={actions.onCancelEditingSession}
      onSaveEditingSession={actions.onSaveEditingSession} onDeleteSession={actions.onDeleteSession}
      onFork={actions.onForkSession?()=>actions.onForkSession?.({id,summary:title,__provider:provider as LLMProvider,__projectId:projectId??undefined}):undefined} t={t}/>
      :<ActionMenu label="Session options" ariaLabel={`Session options for ${title}`} icon={MoreHorizontal} iconOnly variant="ghost" size="icon" triggerClassName="h-7 w-7" menuClassName="z-[100]" items={[
        ...(sections?.layout?[{key:'section',label:'移到分区 ▸',onSelect:()=>sections.openMove({kind:'session',targetId:id,title})}]:[]),
        ...(workspace?.ready&&row?[
          {key:'read',label:t(row.unread?'inbox.markRead':'inbox.markUnread',{title}),icon:row.unread?MailOpen:Mail,onSelect:()=>{void workspace.change(id,row.unread?{unread:false,readThrough:row.lastActivityAt}:{unread:true}).catch(()=>{});}},
          {key:'pin',label:t(row.pinnedAt!==null?'inbox.unpin':'inbox.pin',{title}),icon:row.pinnedAt!==null?PinOff:Pin,onSelect:()=>{void workspace.change(id,{pinned:row.pinnedAt===null}).catch(()=>{});}},
        ]:[]),
      ]}/>}/>;
}
