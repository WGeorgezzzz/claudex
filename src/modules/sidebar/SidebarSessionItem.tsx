import { memo } from 'react';
import type { TFunction } from 'i18next';
import { CheckSquare, Square } from 'lucide-react';
import { SessionRow } from '@/modules/sidebar/SessionRow';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import { createSessionViewModel } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';

type SidebarSessionItemProps = {
  project: Project; session: SessionWithProvider; selectedSession: ProjectSession | null;
  isProcessing: boolean; hasBackgroundWork: boolean; needsAttention: boolean; currentTime: Date;
  isEditing: boolean; renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onEditOrganization?: () => void;
  isSelecting: boolean; isChecked: boolean;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  t: TFunction;
};

/** Project and organization lists bind existing actions to the shared session row. */
function SidebarSessionItem(props: SidebarSessionItemProps) {
  const { project, session, t } = props;
  const view = createSessionViewModel(session, props.currentTime, t);
  const selectable = props.isSelecting && !props.isProcessing;
  const SelectionIcon = props.isChecked ? CheckSquare : Square;
  const toggle = () => props.onToggleSessionSelected(project.projectId, session.id);
  return <SessionRow sessionId={session.id} title={view.sessionName} provider={session.__provider}
    selected={props.selectedSession?.id === session.id} processing={props.isProcessing}
    background={props.hasBackgroundWork} attention={props.needsAttention} recent={view.isActive} t={t}
    selecting={props.isSelecting} checked={props.isChecked} disabled={props.isSelecting && !selectable}
    selectionIcon={props.isSelecting ? <SelectionIcon className="h-4 w-4 shrink-0 text-muted-foreground"/> : undefined}
    onSelect={() => { if(props.isSelecting){if(selectable)toggle();}else props.onSessionSelect(session, project.projectId); }}
    options={!props.isSelecting && <SessionOptions sessionId={session.id} sessionName={view.sessionName}
      provider={session.__provider} projectId={project.projectId} isProcessing={props.isProcessing} hasBackgroundWork={props.hasBackgroundWork}
      isEditing={props.isEditing} renameDraft={props.renameDraft} onRenameDraftChange={props.onRenameDraftChange}
      onStartEditingSession={props.onStartEditingSession} onCancelEditingSession={props.onCancelEditingSession}
      onSaveEditingSession={props.onSaveEditingSession} onDeleteSession={props.onDeleteSession}
      onFork={props.onForkSession ? () => props.onForkSession?.(session) : undefined}
      onEditOrganization={props.onEditOrganization} t={t}/>}/>;
}

export default memo(SidebarSessionItem);
