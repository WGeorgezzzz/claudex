import React, { useCallback, useEffect, type Dispatch, type SetStateAction, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal, X } from 'lucide-react';

import { ChatInterface } from '@/modules/chat';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOps, usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, DirectoryRevealRequest, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab } from '@/shared/types';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useSelectedProvider } from '@/shared/hooks/useSelectedProvider';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';
import { useWorkspaceSplit } from '@/modules/project-workspace/hooks/useWorkspaceSplit';
import { SideChatPanel } from '@/modules/project-workspace/SideChatPanel';

type WorkspaceMainProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. Used by the header's inline rename. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by ProjectMainRegion to show the selected project's active tab: chat, files, shell, git, tasks, browser or a plugin. */
function WorkspaceMain({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
  onRenameSession,
}: WorkspaceMainProps) {
  const { t } = useTranslation('chat');
  const selectedProvider = useSelectedProvider();
  const isClaude = (selectedSession?.__provider ?? selectedSession?.provider ?? selectedProvider) === 'claude';
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;
  // Retains the user's choice of a side-by-side Claude workspace across reloads.
  const [splitEnabled, setSplitEnabled] = useState(() => localStorage.getItem('claude-workspace-split') !== 'false');
  const workspaceSplit = useWorkspaceSplit();
  const paletteOps = usePaletteOps();
  // The parent ID prevents a panel belonging to one conversation appearing in another.
  const [sideChat, setSideChat] = useState<{ parentId: string; draft?: { id: number; text: string } } | null>(null);
  const sideChatOpen = Boolean(isClaude && selectedSession && sideChat?.parentId === selectedSession.id);
  const openSideChat = useCallback((prompt?: string) => {
    if (!isClaude || !selectedSession) return;
    setSideChat({ parentId: selectedSession.id,
      ...(prompt ? { draft: { id: Date.now(), text: prompt } } : {}) });
    setActiveTab('chat');
  }, [isClaude, selectedSession?.id, setActiveTab]);
  const openSelectedSideChat = useCallback(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode?.parentElement;
    const selectedText = anchor?.closest('[data-testid="workspace-chat-pane"]') ? selection?.toString().trim() : '';
    openSideChat(selectedText ? `${t('sideChat.selectedContext')}\n\n${selectedText}\n\n` : undefined);
  }, [openSideChat, t]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 's' && isClaude && selectedSession) {
        event.preventDefault(); openSelectedSideChat();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [isClaude, selectedSession?.id, openSelectedSideChat]);
  // Keep this project's terminal mounted when the user returns to chat, preserving its shell.
  const [terminalProjectId, setTerminalProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (isClaude && activeTab === 'shell' && selectedProject) setTerminalProjectId(selectedProject.projectId);
  }, [isClaude, activeTab, selectedProject?.projectId]);

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  useTaskMasterProjectSync(selectedProject);
  // The folder an in-chat `path/` reference asked to reveal. Held as an object
  // so that re-clicking the same folder is a new request the tree acts on.
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });
  const splitPane = isClaude && !sideChatOpen && !isMobile && splitEnabled && !editingFile && !editorExpanded
    && ['shell', 'files', 'git', 'browser'].includes(activeTab);
  const panelClass = splitPane ? 'workspace-pane flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-l border-border' : 'h-full w-full overflow-hidden';
  const panelStyle = splitPane ? { width: `${workspaceSplit.percent}%` } : undefined;
  const paneHeader=splitPane?<div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3 text-xs text-muted-foreground"><span>{t(`ui.panes.${activeTab}`)}</span><button type="button" className="workspace-icon-button" aria-label={t('desktop.closePane')} onClick={()=>setActiveTab('chat')}><X size={14}/></button></div>:null;
  const openWorkspaceFile = useCallback((filePath: string) => {
    if (handleFileOpen(filePath) && isClaude) setActiveTab('chat');
  }, [handleFileOpen, isClaude, setActiveTab]);

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  // Stable so React.memo(ChatInterface) can bail out: an inline arrow here made
  // every WorkspaceMain render re-render the whole chat tree, including during
  // an editor-divider drag.
  const showAllTasks = useCallback(() => {
    setActiveTab('tasks');
  }, [setActiveTab]);

  const openFile = useCallback((filePath: string) => {
    if (handleFileOpen(filePath)) {
      setActiveTab('files');
    }
  }, [handleFileOpen, setActiveTab]);

  // Opens the editor side panel in place, keeping the current tab (e.g. chat).
  const openFileInEditor = useCallback((filePath: string, line?: number | null) => {
    resolvedFileOpen(filePath, undefined, line);
  }, [resolvedFileOpen]);

  // Directories cannot be read as text: reveal them in the file tree instead.
  const openDirectory = useCallback((directoryPath: string) => {
    setActiveTab('files');
    setRevealDirectory({ path: directoryPath });
  }, [setActiveTab]);

  // Stable arguments keep usePaletteOpsRegister's effect from tearing down and
  // rewriting the whole palette registry on every render.
  usePaletteOpsRegister({ openFile, openFileInEditor, openDirectory });

  if (isLoading) {
    return <WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onRenameSession={onRenameSession}
        claudeLayout={isClaude}
        onOpenSideChat={isClaude && selectedSession ? openSelectedSideChat : undefined}
        sideChatOpen={sideChatOpen}
        displayOptions={isClaude&&<details className="workspace-display-menu relative shrink-0 self-end sm:self-center">
          <summary aria-label={t('ui.displayOptions')} title={t('ui.displayOptions')} className="workspace-icon-button cursor-pointer list-none"><SlidersHorizontal size={16}/></summary>
          <div className="workspace-view-options absolute right-0 top-full z-50 mt-2 flex w-56 flex-col gap-3 rounded-xl border border-border bg-popover p-3 text-xs text-muted-foreground shadow-lg" data-testid="claude-workspace-controls">
          {!isMobile && <label className="flex items-center gap-1.5"><input type="checkbox" checked={splitEnabled} onChange={event => {
            setSplitEnabled(event.target.checked);
            localStorage.setItem('claude-workspace-split', String(event.target.checked));
          }} />{t('desktop.sideBySide', 'Side by side')}</label>}
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={showThinking} onChange={event => setPreference('showThinking',event.target.checked)} />{t('desktop.showThinking', 'Show thinking')}</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={showRawParameters} onChange={event => setPreference('showRawParameters',event.target.checked)} />{t('desktop.showParameters', 'Show tool parameters')}</label>
          {(activeTab !== 'chat' || editingFile) && <button type="button" className="ml-auto rounded px-2 py-1 hover:bg-muted" onClick={() => {
            if (editingFile) handleCloseEditor();
            else setActiveTab('chat');
          }}>{t('desktop.closePane', 'Close pane')}</button>}
          </div>
        </details>}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={workspaceSplit.containerRef} className={`flex min-h-0 min-w-[200px] ${splitPane ? 'flex-row' : 'flex-col'} overflow-hidden ${editorExpanded && !sideChatOpen ? 'hidden' : ''} flex-1`}>
          <div className={`h-full min-w-0 ${splitPane ? 'flex-1' : ''} ${activeTab === 'chat' || splitPane ? 'block' : 'hidden'}`} data-testid="workspace-chat-pane">
            <WorkspaceErrorBoundary showDetails>
              <ChatInterface
                isActive={activeTab === 'chat' || splitPane}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                onOpenSideChat={isClaude && selectedSession ? openSideChat : undefined}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={tasksEnabled ? showAllTasks : null}
              />
            </WorkspaceErrorBoundary>
          </div>

          {splitPane && <div {...workspaceSplit.separatorProps}
            aria-label={t('desktop.resizePane', 'Resize workspace pane')}
            className="w-1 shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary focus-visible:bg-primary focus-visible:outline-none" />}
          {activeTab === 'files' && (
            <div className={panelClass} style={panelStyle} data-claude-side-pane={isClaude || undefined}>
              {paneHeader}
              <FileTree
                selectedProject={selectedProject}
                onFileOpen={openWorkspaceFile}
                revealDirectory={revealDirectory}
              />
            </div>
          )}

          {(activeTab === 'shell' || (isClaude && terminalProjectId === selectedProject.projectId)) && (
            <div className={activeTab === 'shell' ? panelClass : 'hidden'} style={panelStyle} data-claude-side-pane={isClaude || undefined}>
              {paneHeader}
              <StandaloneShell
                key={selectedProject.projectId}
                project={selectedProject}
                session={isClaude ? null : selectedSession}
                isPlainShell={isClaude ? true : null}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
            </div>
          )}

          {activeTab === 'git' && (
            <div className={panelClass} style={panelStyle} data-claude-side-pane={isClaude || undefined}>
              {paneHeader}
              <GitPanel
                selectedProject={selectedProject}
                isMobile={isMobile}
                onFileOpen={openWorkspaceFile}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
              />
            </div>
          )}

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className={panelClass} style={panelStyle} data-claude-side-pane={isClaude || undefined}>
              {paneHeader}
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        <div className={sideChatOpen ? 'hidden' : 'contents'}>
        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          onUnsavedChangesChange={handleUnsavedChangesChange}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
        </div>
        {sideChatOpen && selectedSession && <div className="side-chat-dock">
          <SideChatPanel key={selectedSession.id} parent={selectedSession} project={selectedProject}
            ws={ws} sendMessage={sendMessage} draft={sideChat?.draft}
            onDraftConsumed={()=>setSideChat(value=>value?{...value,draft:undefined}:value)}
            onClose={() => setSideChat(null)} onShowSettings={onShowSettings}
            showThinking={showThinking} showRawParameters={showRawParameters} sendByCtrlEnter={sendByCtrlEnter}
            onPromote={id => { setSideChat(null); onNavigateToSession(id); }}
            onReturnReply={text => paletteOps.insertComposerText(`${t('sideChat.replyPrefix')}\n\n${text}`)}/>
        </div>}
      </div>
    </div>
  );
}

export default React.memo(WorkspaceMain);
