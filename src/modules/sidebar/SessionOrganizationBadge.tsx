import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionMonitorBadge } from '@/shared/ui';
import { useSessionWorkspace } from '@/modules/sidebar/context/SessionWorkspaceContext';

/** Project and recent rows show the same persisted pinned/unread state as their menus. */
export function SessionOrganizationBadge({sessionId}:{sessionId:string}) {
  const row=useSessionWorkspace()?.byId.get(sessionId);const {t}=useTranslation('sidebar');

  return <span className="inline-flex shrink-0 items-center gap-1 align-middle [&_button]:m-0 [&_button]:p-0.5 [&_svg]:h-3 [&_svg]:w-3"><SessionMonitorBadge sessionId={sessionId}/>
    {row?.pinnedAt&&<Pin size={10} aria-label={t('workspace.pinned')} className="text-muted-foreground"/>}
    {row?.unread&&<span aria-label={t('workspace.unread')} className="h-1.5 w-1.5 rounded-full bg-blue-500"/>}
  </span>;
}
