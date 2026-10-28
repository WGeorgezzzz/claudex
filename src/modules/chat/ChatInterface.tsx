import { InvocationCatalogContext } from '@/modules/chat/utils/invocationTokens';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings, ConversationTasksPanel,TaskSourceBanner } from '@/modules/task-master';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { api } from '@/shared/api';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { supportsLiveInsertion, useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import { useMessageQueue } from '@/modules/chat/composer/useMessageQueue';
import { useQueuedTurnSync } from '@/modules/chat/hooks/useQueuedTurnSync';
import { MessageQueuePanel } from '@/modules/chat/composer/MessageQueuePanel';
import { restoreLiveInsertionMessages } from '@/modules/chat/utils/liveInsertionMessages';
import { NextPromptSuggestions } from '@/modules/chat/composer/NextPromptSuggestions';
import { CrossSessionDialog } from '@/modules/chat/modals/CrossSessionDialog';

type ChatInterfaceProps = {
  isSideChat?: boolean;
  contextCutoff?: string;
  onOpenSideChat?: (prompt?: string) => void;
  draftInsertion?: { id: number; text: string };
  onDraftInserted?: ()=>void;
  onReturnReply?: (text: string) => void;
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isSideChat = false,
  contextCutoff,
  onOpenSideChat,
  draftInsertion,
  onDraftInserted,
  onReturnReply,
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
    markSessionBackground: onSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    permissionModeNamespace,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });
  const messageQueue=useMessageQueue(currentSessionId || selectedSession?.id || null);
  // A side chat keeps the full provider context, while inherited rows are folded in its UI.
  const [showInherited,setShowInherited]=useState(false);
  const contextTime=contextCutoff?Date.parse(contextCutoff):NaN;
  const showMessage=(message:ChatMessage)=>showInherited || !Number.isFinite(contextTime)
    || new Date(message.timestamp instanceof Date?message.timestamp.getTime():message.timestamp).getTime()>contextTime;
  // Live receipts are authoritative even when provider history omits streaming-input user rows.
  const restoredMessages=restoreLiveInsertionMessages(chatMessages,messageQueue.items);
  const restoredVisibleMessages=restoreLiveInsertionMessages(visibleMessages,messageQueue.items);
  const displayMessages=isSideChat?restoredMessages.filter(showMessage):restoredMessages;
  const displayVisibleMessages=isSideChat?restoredVisibleMessages.filter(showMessage):restoredVisibleMessages;

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    busySendMode,
    setBusySendMode,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    commandsForHighlight,fileNamesForHighlight,invocationWarning,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handleForceStopSession,
    canForceStop,
    isStopping,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
  } = useChatComposerState({
    enqueueMessage:messageQueue.enqueue,
    sendLiveMessage:messageQueue.sendLive,
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    onOpenSideChat,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(() => {
    if (!selectedProject || !selectedSession) return;
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
    // Reattach live output immediately; a slow history fetch must not hold the stream hostage.
    void requestLatestMessages(selectedSession.id, isActive).catch(error => console.warn('Reconnect history refresh failed:', error));
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useQueuedTurnSync(selectedSession?.id || null, messageQueue.items, handleWebSocketReconnect);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  // Lets other modules (the quick settings Commands tab) hand text to the
  // composer: append it after a separating space, then focus the textarea with
  // the caret at the end once React has rendered the new value.
  // A source outside the loaded tail must wait for full history before revealing its row.
  const [taskSource, setTaskSource] = useState<{id: string; evidence: string} | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('taskMessage');
    if (id) { setTaskSource({ id, evidence: '' }); void loadFullTranscript(); }
  }, [currentSessionId, loadFullTranscript]);
  useEffect(() => {
    if (!taskSource) return;
    const source = chatMessages.find(m => m.id === taskSource.id || m.transcriptAnchorId === taskSource.id || (taskSource.evidence && typeof m.content === 'string' && m.content.includes(taskSource.evidence)));
    if (source) { revealMessage(source); setTaskSource(null); }
  }, [chatMessages, taskSource, revealMessage]);
  const insertComposerText = useCallback((text: string) => {
    setInput((previous) => {
      const separator = previous && !/\s$/.test(previous) ? ' ' : '';
      return `${previous}${separator}${text}`;
    });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const caretPosition = textarea.value.length;
      textarea.setSelectionRange(caretPosition, caretPosition);
    });
  }, [setInput, textareaRef]);

  usePaletteOpsRegister(isSideChat ? {} : { insertComposerText });

  // A selected passage or /side question is inserted once without submitting it.
  const appliedDraft = useRef<number | null>(null);
  useEffect(() => {
    if (!draftInsertion || appliedDraft.current === draftInsertion.id) return;
    appliedDraft.current = draftInsertion.id;
    insertComposerText(draftInsertion.text);
    onDraftInserted?.();
  }, [draftInsertion, insertComposerText, onDraftInserted]);

  useEffect(() => {
    if (!canAbortSession || isSideChat) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }
      // A side pane's terminal/editor owns Escape; it must not stop the chat.
      if (event.target instanceof Element && event.target.closest('[data-claude-side-pane], .cm-editor, [role="dialog"], [role="menu"]')) return;

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isSideChat]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode },
    });
    if (scheduled) {
      setInput('');
    }
  }, [currentProviderEffort, currentProviderModel, input, permissionMode, scheduleMessage, setInput]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
    onPlanApproved: provider === 'claude' ? () => selectPermissionMode('default') : undefined,
  }), [pendingPermissionRequests, handlePermissionDecision, provider, selectPermissionMode]);

  const [resolvedCwd,setResolvedCwd]=useState<{id:string;path:string}|null>(null);
  const invocationCatalog=useMemo(()=>({commands:commandsForHighlight||[],files:fileNamesForHighlight||[]}),[commandsForHighlight,fileNamesForHighlight]);
  const pathSessionId=currentSessionId || selectedSession?.id;
  useEffect(()=>{if(!pathSessionId||isSideChat)return;localStorage.setItem('nexagent.currentSession',pathSessionId);const key='nexagent.taskDraft:'+pathSessionId;const draft=sessionStorage.getItem(key);if(draft){sessionStorage.removeItem(key);setInput(old=>old?old+'\n\n'+draft:draft);textareaRef.current?.focus();}},[pathSessionId,isSideChat,setInput]);
  useEffect(()=>{
    let active=true;
    if(pathSessionId) void api.sessionWorkspace.get(pathSessionId).then(response=>response.ok?response.json():null).then(result=>{
      if(active && typeof result?.data?.projectPath==='string')setResolvedCwd({id:pathSessionId,path:result.data.projectPath});
    }).catch(()=>{});
    return()=>{active=false;};
  },[pathSessionId]);
  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
    cwd: resolvedCwd && resolvedCwd.id===pathSessionId ? resolvedCwd.path : typeof selectedSession?.cwd === 'string' ? selectedSession.cwd : typeof selectedSession?.workingDirectory === 'string' ? selectedSession.workingDirectory : typeof selectedSession?.projectPath === 'string' ? selectedSession.projectPath : typeof selectedSession?.project_path === 'string' ? selectedSession.project_path : null,
    projectPath: selectedProject?.fullPath || selectedProject?.path || null,
  }), [selectedProject?.projectId, selectedProject?.fullPath, selectedProject?.path, selectedSession?.cwd, selectedSession?.workingDirectory, selectedSession?.projectPath, selectedSession?.project_path, resolvedCwd, pathSessionId]);

  // Lets a workflow card fetch its agents' timelines for this session.
  const transcriptSessionValue = useMemo(() => ({ sessionId: currentSessionId }), [currentSessionId]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'gemini' ? 'Gemini' : provider === 'deepseek-harness' ? 'DeepSeek Harness' : provider === 'workbuddy' ? 'WorkBuddy' : provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}><InvocationCatalogContext.Provider value={invocationCatalog}>
      <div className="flex h-full min-h-0 flex-col">
          <TaskSourceBanner sessionId={currentSessionId||selectedSession?.id}/>
        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <TranscriptSessionContext.Provider value={transcriptSessionValue}>
            {isSideChat && contextCutoff && <button type="button"
              className="mx-4 mt-2 self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              onClick={()=>setShowInherited(value=>!value)}>{t(showInherited?'sideChat.hideContext':'sideChat.showContext')}</button>}
            <ConversationTasksPanel key={currentSessionId || selectedSession?.id} sessionId={currentSessionId || selectedSession?.id || null} busy={isProcessing}
              onExecute={text => {
                const id = currentSessionId || selectedSession?.id;
                if (!id || isProcessing) return;
                sendMessage({ type: 'chat.send', sessionId: id, content: text, options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode } });
                addMessage({ type: 'user', content: text, timestamp: new Date() });
              }}
              onSource={(id, evidence) => {
                const message = chatMessages.find(m => m.id === id || m.transcriptAnchorId === id || (typeof m.content === 'string' && m.content.includes(evidence)));
                if (message) revealMessage(message); else { setTaskSource({id, evidence}); void loadFullTranscript(); }
              }}/>
            <ChatMessagesPane
              scrollContainerRef={scrollContainerRef}
              // Not redundant with the `scroll` listener. A first page is 20 rows,
              // tool results fold into their calls, and the "load earlier" link is
              // hidden while more pages exist — so a short transcript is often not
              // scrollable at all and never emits `scroll`. Wheel and touch are
              // then the only way to reach the top pager or the "load all" overlay.
              onWheel={handleScroll}
              onTouchMove={handleScroll}
              isLoadingSessionMessages={isLoadingSessionMessages}
              isProcessing={isProcessing}
              hasActivityIndicator={hasActivityIndicator}
              chatMessages={displayMessages}
              selectedSession={selectedSession}
              currentSessionId={currentSessionId}
              provider={provider}
              setProvider={setProvider}
              textareaRef={textareaRef}
              providerModels={providerModels}
              setProviderModel={setStoredProviderModel}
              providerModelCatalog={providerModelCatalog}
              providerModelActions={providerModelActions}
              providerModelsLoading={providerModelsLoading}
              tasksEnabled={tasksEnabled}
              isTaskMasterInstalled={isTaskMasterInstalled}
              onShowAllTasks={onShowAllTasks}
              setInput={setInput}
              isLoadingMoreMessages={isLoadingMoreMessages}
              hasMoreMessages={hasMoreMessages}
              totalMessages={totalMessages}
              sessionMessagesCount={chatMessages.length}
              visibleMessageCount={visibleMessageCount}
              visibleMessages={displayVisibleMessages}
              loadEarlierMessages={loadEarlierMessages}
              revealMessage={revealMessage}
              backgroundTasks={sessionActivity?.tasks}
              sendMessage={sendMessage}
              loadAllMessages={loadAllMessages}
              allMessagesLoaded={allMessagesLoaded}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              showLoadAllOverlay={showLoadAllOverlay}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={handleGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              // Editing replaces the turn and everything after it, so it is only
              // offered when the session is idle — a half-truncated transcript with
              // a live stream writing into it is not recoverable.
              onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
              onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
              onLoadFullTranscript={loadFullTranscript}
            />
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          {onReturnReply && <div className="flex justify-end px-4 pb-2">
            <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
              disabled={!displayMessages.some(message => message.type === 'assistant' && !message.isThinking && !message.isToolUse && typeof message.content === 'string' && message.content.trim())}
              onClick={() => {
                const answer = [...displayMessages].reverse().find(message => message.type === 'assistant' && !message.isThinking && !message.isToolUse && typeof message.content === 'string' && message.content.trim());
                if (answer) onReturnReply(String(answer.content));
              }}>{t('sideChat.returnReply')}</button>
          </div>}
          <NextPromptSuggestions messages={displayMessages} busy={isProcessing} onInsert={insertComposerText}
            sessionId={currentSessionId || selectedSession?.id} provider={provider}/>
          <ChatComposer
          provider={provider}
          extraActions={provider === 'claude' && (currentSessionId || selectedSession?.id) ? <CrossSessionDialog key={`bridge-${currentSessionId || selectedSession?.id}`} sourceSessionId={(currentSessionId || selectedSession?.id)!} draft={input} onInsert={insertComposerText}/> : undefined}
          busySendMode={busySendMode}
          onBusySendModeChange={setBusySendMode}
          supportsLiveInput={supportsLiveInsertion(provider)}
          compact={isSideChat}
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          canForceStop={canForceStop}
          isStopping={isStopping}
          onForceStopSession={handleForceStopSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          permissionModeNamespace={permissionModeNamespace}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          monitorSessionId={provider === 'claude' ? (currentSessionId || selectedSession?.id || null) : null}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          submissionNotice={[messageQueue.notice,invocationWarning?'未找到该技能：'+invocationWarning:''].filter(Boolean).join(' · ')}
          pendingTray={<MessageQueuePanel key={currentSessionId||selectedSession?.id||'new'} items={messageQueue.items}
            error={messageQueue.error} update={messageQueue.update} attempts={messageQueue.attempts}
            paused={messageQueue.paused} setPaused={messageQueue.setPaused} retryLive={async item => {
              const outcome=await messageQueue.retryLive(item);
              if(outcome==='live')addMessage({type:'user',content:item.content,timestamp:new Date(),insertedMidTurn:true});
            }}
            convertLive={messageQueue.convertLive} queuedDraft={queuedDraft} onEditQueuedDraft={editQueuedDraft} onDeleteQueuedDraft={deleteQueuedDraft}/>}
          backgroundSendPrompt={backgroundSendPrompt}
          onResolveBackgroundSendPrompt={resolveBackgroundSendPrompt}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </InvocationCatalogContext.Provider></PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
