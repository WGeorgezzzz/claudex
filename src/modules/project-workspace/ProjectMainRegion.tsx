import { memo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { GlobalTasksPage } from '@/modules/task-master';

import { useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SessionEstablishedContext, SessionNavigationOptions,ProjectWorkspaceShellProps } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import { InfoHubPage } from '@/modules/info-hub';

/** Rendered by ProjectWorkspaceShell to bind this module's project state to WorkspaceMain. */
function ProjectMainRegion({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const location = useLocation();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    setSidebarOpen,
    isLoadingProjects,
    openSettings,
    externalMessageUpdate,
    newSessionTrigger,
    registerOptimisticSession,
    handleProjectSelect,
    refreshProjectsSilently,
    renameSession,
  } = useProjectMainState();

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const handleNavigateToSession = useCallback((
    targetSessionId: string,
    options?: SessionNavigationOptions,
  ) => {
    navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) });
  }, [navigate]);

  const handleSessionEstablished = useCallback((
    targetSessionId: string,
    context: SessionEstablishedContext,
  ) => {
    registerOptimisticSession({ sessionId: targetSessionId, ...context });
    window.dispatchEvent(new CustomEvent('workspace:session-established', { detail: { sessionId: targetSessionId } }));
  }, [registerOptimisticSession]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  if (location.pathname === '/tasks') return <GlobalTasksPage onMenuClick={handleOpenSidebar}/>;
  if (['/infohub', '/information'].includes(location.pathname)) return <InfoHubPage onMenuClick={handleOpenSidebar}/>;
  return (
    <WorkspaceMain
      onOpenTasks={projectId => navigate('/tasks?project=' + encodeURIComponent(projectId))}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      ws={ws}
      sendMessage={sendMessage}
      isMobile={isMobile}
      onMenuClick={handleOpenSidebar}
      isLoading={isLoadingProjects}
      onNavigateToSession={handleNavigateToSession}
      onSessionEstablished={handleSessionEstablished}
      onShowSettings={openSettings}
      externalMessageUpdate={externalMessageUpdate}
      newSessionTrigger={newSessionTrigger}
      onProjectSelect={handleProjectSelect}
      onProjectsRefresh={handleProjectsRefresh}
      onRenameSession={renameSession}
    />
  );
}

export default memo(ProjectMainRegion);
