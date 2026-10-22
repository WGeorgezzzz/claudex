import { memo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { CommandPalette } from '@/modules/command-palette';
import type { LLMProvider, PaletteSessionEntry } from '@/shared/types';

/** Rendered by ProjectWorkspaceShell to bind this module's project state to the command-palette module. */
function ProjectCommandPalette() {
  const {
    selectedProject,
    handleNewSession,
    openSettings,
    setActiveTab,
    projects,
    handleSessionSelect,
  } = useProjectCommandState();
  const navigate = useNavigate();
  const selectSession = useCallback((entry: PaletteSessionEntry) => {
    const project = projects.find(candidate => candidate.projectId === entry.projectId);
    if (!project) {
      // The normal deep-link resolver obtains paths when the project is not loaded.
      navigate(`/session/${encodeURIComponent(entry.id)}`); return;
    }
    const existing = project.sessions?.find(session => session.id === entry.id);
    handleSessionSelect({...existing, id: entry.id, summary: entry.label, __projectId: project.projectId, __provider: (entry.provider ?? existing?.__provider) as LLMProvider,
      __searchTargetSnippet: entry.snippet ?? null, __searchTargetTimestamp: entry.timestamp ?? null});
  }, [projects, handleSessionSelect, navigate]);

  return (
    <CommandPalette
      selectedProject={selectedProject}
      onStartNewChat={handleNewSession}
      onOpenSettings={openSettings}
      onShowTab={setActiveTab}
      onSelectSession={selectSession}
    />
  );
}

export default memo(ProjectCommandPalette);
