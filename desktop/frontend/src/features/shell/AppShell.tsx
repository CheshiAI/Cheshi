import type { VerificationReview } from '../agent-chats/verificationReviewModel';
import { WorkerWorkspace, type WorkerWorkspaceHandle } from './WorkerWorkspace';
import { SchedulerNotifications } from '../scheduler/SchedulerNotifications';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RegionalBlur, LiquidGlassPanel, SidebarToggleVisibility, SlidingSidePanel } from '../../shared/ui';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import {
  ChatSessionList,
  type ChatActivityItem,
} from '../chat';
import { ChatWorkspace } from '../chat/ChatWorkspace';
import { FlashSourceNavigationContext } from '../chat/FlashSourceLink';
import { CHAT_PANE_MIN_WIDTH } from '../chat/chatWorkspaceModel';
import { cheshiDesktop } from '../../cheshiDesktop';
import { ChatDeleteSessionDialog } from '../chat/ChatDeleteSessionDialog';
import { ChatHistoryOpenDialog } from '../chat/ChatHistoryOpenDialog';
import { ChatHistorySearchBar } from '../chat/ChatHistorySearchBar';
import { ChatHistorySearchPage } from '../chat/ChatHistorySearchPage';
import { useChatHistorySearch } from '../chat/useChatHistorySearch';
import type { ChatHistorySearchHit } from '../../../../shared/chat-history-search';
import type { GitLineBlameRequest } from '../../../../shared/git-line-blame';
import type { ChatHistorySearchTarget } from '../chat/chatHistorySearchNavigation';
import { useChatWorkspace } from '../chat/useChatWorkspace';
import { WindowTabs } from '../chrome/WindowChrome';
import {
  WorkspaceEditor,
  type WorkspaceEditorMutation,
  type WorkspaceEditorTarget,
} from '../editor';
import { GitWorkspace } from '../git';
import { CodeGraphView } from '../graph';
import { useCodeGraphIndex } from '../graph/useCodeGraphIndex';
import { BlankView } from '../home/BlankView';
import { Sidebar, type WorkspaceView } from '../navigation/Sidebar';
import { saveSidebarPanel, sidebarPanelForWorkspace, type SidebarPanel } from '../navigation/sidebarPanel';
import { SidebarRail } from '../navigation/SidebarRail';
import { ExplorerView } from '../navigation/ExplorerView';
import { PluginsView } from '../plugins';
import { TerminalWorkspace } from '../terminal';
import { SettingsView } from '../settings/SettingsView';
import { DiscordSetupConfirmation } from '../settings/DiscordSetupConfirmation';
import { ReviewSidebar } from './ReviewSidebar';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';
import styles from './AppShell.module.css';
import { WorkspaceSurfaceReporter } from './WorkspaceSurfaceReporter';
import { useAppUpdateResume } from './useAppUpdateResume';
import { useWorkflowChatNavigation } from './useWorkflowChatNavigation';
import { useToolsMenu } from './useToolsMenu';
import { VoiceView } from '../voice/VoiceView';
import { WorkspaceEditorSplit } from './WorkspaceEditorSplit';
import { readWorkspaceLayout, replaceWorkspacePane, revealWorkspacePane, saveWorkspaceLayout, visibleWorkspaceLayout, type WorkspacePaneId } from './workspaceLayoutModel';
import { removeSplitPane, splitPaneIds } from '../../shared/ui/splitPaneModel';
import { WorkspaceFileSearch } from '../navigation/WorkspaceFileSearch';
import { installFileSearchShortcut } from '../navigation/fileSearchShortcut';
import { ChatDraftAttachmentsContext, createChatDraftAttachments } from '../chat/chatDraftAttachments';
import { MemoSidebar } from '../sticky-notes/MemoSidebar';
import { CalendarView } from '../calendar/CalendarView';

const fullWidthViews: readonly WorkspaceView[] = ['explorer', 'chats', 'git', 'plugins', 'calendar', 'voice', 'settings', 'docker'];

export function AppShell() {
  const notificationSceneRef = useRef<HTMLDivElement>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [temporaryChatOpen, setTemporaryChatOpen] = useState(false);
  useEffect(() => {
    const api = cheshiDesktop?.temporaryChat;
    if (!api) return;
    let active = true, changed = false;
    const unsubscribe = api.onWindowChanged(open => { changed = true; setTemporaryChatOpen(open); });
    void api.isWindowOpen().then(open => { if (active && !changed) setTemporaryChatOpen(open); }).catch(console.error);
    return () => { active = false; unsubscribe(); };
  }, []);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState('');
  const [historyTarget, setHistoryTarget] = useState<ChatHistorySearchTarget | null>(null);
  const historyRequestId = useRef(0);
  const handleHistoryTarget = useCallback((requestId: number) => {
    setHistoryTarget((current) => current?.requestId === requestId ? null : current);
  }, []);
  const codeGraphIndex = useCodeGraphIndex();
  const indexLoaded = codeGraphIndex.status.state !== 'loading';
  const accountReady = useCallback(() => setAccountLoaded(true), []);
  const startupReported = useRef(false);
  const [customLayout, setCustomLayout] = useState(readWorkspaceLayout);
  const [activeView, setActiveView] = useState<WorkspaceView>(() =>
    customLayout && splitPaneIds(customLayout).includes('primary') && ['editor', 'worker'].some(pane => splitPaneIds(customLayout).includes(pane)) ? 'chat'
      : customLayout && splitPaneIds(customLayout).includes('worker') ? 'chats' : 'explorer');
  const [workerView, setWorkerView] = useState<'chats' | 'docker'>('chats');
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<'agents' | 'voice'>('agents');
  const [focusedPane, setFocusedPane] = useState<WorkspacePaneId>(() =>
    customLayout && splitPaneIds(customLayout).includes('editor') ? 'editor'
      : customLayout && splitPaneIds(customLayout).includes('worker') && !splitPaneIds(customLayout).includes('primary') ? 'worker' : 'primary');
  const [paneFocusRequest, setPaneFocusRequest] = useState<{ paneId: WorkspacePaneId; requestId: number } | null>(null);
  const focusWorkspacePane = useCallback((paneId: WorkspacePaneId) => {
    setFocusedPane(paneId);
    setPaneFocusRequest(current => ({ paneId, requestId: (current?.requestId ?? 0) + 1 }));
  }, []);
  const previousView = useRef(activeView);
  useEffect(() => {
    if (previousView.current === activeView) return;
    previousView.current = activeView;
    if (activeView === 'chats' || activeView === 'docker') setWorkerView(activeView);
    setFocusedPane(activeView === 'editor' ? 'editor' : activeView === 'terminal' ? 'terminal'
      : activeView === 'chats' || activeView === 'docker' ? 'worker' : 'primary');
  }, [activeView]);
  const [historyChoice, setHistoryChoice] = useState<{ sessionId: string; title: string; paneId: string } | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<{ sessionId: string; title: string } | null>(null);
  const [renamingSession, setRenamingSession] = useState(false);
  const workerWorkspace = useRef<WorkerWorkspaceHandle>(null);
  const [fileReview, setFileReview] = useState<{ paneId: string; itemId: string; path: string | null; item?: never }
    | { paneId?: never; itemId: string; path: string | null; item: ChatActivityItem } | null>(null);
  const [verificationReview, setVerificationReview] = useState<VerificationReview | null>(null);
  const [lineCommitTarget, setLineCommitTarget] = useState<GitLineBlameRequest | null>(null);
  const [localHistoryPath, setLocalHistoryPath] = useState<string | null>(null);
  const closeReview = useCallback(() => { workerWorkspace.current?.closeHomies(); setFileReview(null); setVerificationReview(null); setLineCommitTarget(null); setLocalHistoryPath(null); }, []);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [chatsSidebarTarget, setChatsSidebarTarget] = useState<HTMLDivElement | null>(null);
  const [memoSidebarTarget, setMemoSidebarTarget] = useState<HTMLDivElement | null>(null);
  const [githubSidebarTarget, setGithubSidebarTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => { saveWorkspaceLayout(customLayout); }, [customLayout]);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('files');
  useEffect(() => { saveSidebarPanel(sidebarPanel); }, [sidebarPanel]);
  useEffect(() => cheshiDesktop?.notes?.onOpenListRequested(() => {
    setSidebarPanel('memos'); setLeftSidebarOpen(true);
  }), []);
  useEffect(() => cheshiDesktop?.agentRegistry?.onRepositoryReady?.(() => {
    setSidebarPanel('files');
    setLeftSidebarOpen(true);
  }), []);
  const openFileReview = useCallback((paneId: string, itemId: string, path?: string) => {
    workerWorkspace.current?.closeHomies();
    setLineCommitTarget(null);
    setLocalHistoryPath(null);
    setRightSidebarOpen(true);
    setVerificationReview(null);
    setFileReview({ paneId, itemId, path: path ?? null });
  }, []);
  const openChatsFileReview = useCallback((item: ChatActivityItem | null, path?: string) => {
    if (!item) { setFileReview(current => current?.item ? null : current); return; }
    if (path !== undefined) {
      workerWorkspace.current?.closeHomies();
      setVerificationReview(null);
      setLineCommitTarget(null); setLocalHistoryPath(null); setRightSidebarOpen(true);
    }
    setFileReview(current => {
      if (path === undefined && (!current?.item || current.itemId !== item.id)) return current;
      const selectedPath = path ?? current?.path ?? null;
      return current?.item === item && current.path === selectedPath ? current
        : { item, itemId: item.id, path: selectedPath };
    });
  }, []);
  const openVerificationReview = useCallback((review: VerificationReview | null, open = false) => {
    if (open) {
      workerWorkspace.current?.closeHomies();
      setFileReview(null); setLineCommitTarget(null); setLocalHistoryPath(null); setRightSidebarOpen(true);
    }
    setVerificationReview(current => open || !review || current?.id === review.id ? review : current);
  }, []);
  const openLineCommit = useCallback((request: GitLineBlameRequest) => {
    workerWorkspace.current?.closeHomies();
    setFileReview(null); setVerificationReview(null);
    setLocalHistoryPath(null);
    setLineCommitTarget(request);
    setRightSidebarOpen(true);
  }, []);
  const [editorTarget, setEditorTarget] = useState<WorkspaceEditorTarget | null>(null);
  const [editorSplitOpen, setEditorSplitOpen] = useState(false);
  const [primaryPaneClosed, setPrimaryPaneClosed] = useState(false);
  const editorReturnView = useRef<WorkspaceView>('chat');
  const [editorMutation, setEditorMutation] = useState<WorkspaceEditorMutation | null>(null);
  const [editorSelectedPath, setEditorSelectedPath] = useState<string | null>(null);
  const [editorDirtyPaths, setEditorDirtyPaths] = useState<string[]>([]);
  const editorRequestId = useRef(0);
  const editorMutationRequestId = useRef(0);
  const workspace = useChatWorkspace();
  const [draftAttachments] = useState(createChatDraftAttachments);
  const historySearch = useChatHistorySearch(workspace.activePaneId, workspace.paneIds);
  const updateResume = useAppUpdateResume({ activeView, rightSidebarOpen, setActiveView, setRightSidebarOpen, sidebarPanel, setSidebarPanel,
    blockedReason: temporaryChatOpen ? 'Close the temporary chat before updating.'
      : renamingSession ? 'Finish renaming the session before updating.'
        : historyChoice || deleteChoice ? 'Close the conversation dialog before updating.' : null });
  const accountSwitchReason = updateResume.busy ? 'Wait for update preparation or workspace recovery to finish.' : temporaryChatOpen ? 'Close the temporary chat before switching accounts.'
    : renamingSession ? 'Finish renaming the session before switching accounts.'
      : historyChoice || deleteChoice ? 'Close the conversation dialog before switching accounts.'
      : workspace.accountSwitchReason;
  const beforeAccountSelect = (): string | null => accountSwitchReason ?? workspace.beginAccountSwitch();
  const accountSelectionFinished = (changed: boolean, preserveConversation = false): void => {
    workspace.completeAccountSwitch(changed, preserveConversation);
    if (changed) {
      historyRequestId.current += 1;
      historySearch.reset();
      setSubmittedSearchQuery('');
      closeReview(); setHistoryChoice(null); setDeleteChoice(null); setHistoryTarget(null);
    }
  };
  const chat = workspace.activeController;
  useEffect(() => {
    if (updateResume.busy || workspace.accountSwitchPending || temporaryChatOpen) return;
    return installFileSearchShortcut(document, () => setFileSearchOpen(true));
  }, [updateResume.busy, workspace.accountSwitchPending, temporaryChatOpen]);
  useEffect(() => {
    if (startupReported.current || !accountLoaded || !indexLoaded || workspace.sessionHistory.loading) return;
    startupReported.current = true;
    window.dispatchEvent(new Event('cheshi:workspace-content-ready'));
  }, [accountLoaded, indexLoaded, workspace.sessionHistory.loading]);
  const chatSessionSelectionDisabled = !chat || chat.state.phase === 'loading' || workspace.splitPending || workspace.deletePending
    || workspace.accountSwitchPending || chat.configurationPending;
  const reviewedItem = fileReview?.item ?? (fileReview?.paneId ? workspace.controllers[fileReview.paneId]?.state.items : [])
    ?.find((item): item is ChatActivityItem => (
      item.kind === 'activity' && item.activity === 'files' && item.id === fileReview?.itemId
    )) ?? null;
  const reviewing = Boolean(reviewedItem || verificationReview || lineCommitTarget || localHistoryPath !== null);

  const openChat = (sessionId: string): void => {
    if (chatSessionSelectionDisabled) return;
    workspace.dismissError();
    setHistoryChoice({ sessionId, title: chat?.state.sessions.find((session) => session.id === sessionId)?.title ?? sessionId,
      paneId: workspace.activePaneId });
  };

  const openWorkflowChat = useWorkflowChatNavigation(workspace, () => {
    historyRequestId.current += 1;
    setHistoryTarget(null);
    closeReview();
    setActiveView('chat');
    setCustomLayout(current => current && revealWorkspacePane(current, 'primary'));
    setPrimaryPaneClosed(false);
  });

  const openHistorySearchHit = useCallback(async (hit: Pick<ChatHistorySearchHit, 'threadId' | 'itemId'>): Promise<boolean> => {
    if (chatSessionSelectionDisabled || updateResume.busy) return false;
    const requestId = ++historyRequestId.current;
    workspace.dismissError();
    const opened = await workspace.openSession(hit.threadId);
    if (!opened || requestId !== historyRequestId.current) return false;
    closeReview();
    setActiveView('chat');
    setCustomLayout(current => current && revealWorkspacePane(current, 'primary'));
    setPrimaryPaneClosed(false);
    setHistoryTarget({ threadId: hit.threadId, itemId: hit.itemId, requestId });
    return true;
  }, [chatSessionSelectionDisabled, updateResume.busy, workspace.dismissError, workspace.openSession, closeReview]);

  const newChat = (): void => {
    if (workspace.deletePending) return;
    historyRequestId.current += 1;
    closeReview();
    setActiveView('chat');
    setCustomLayout(current => current && revealWorkspacePane(current, 'primary'));
    setPrimaryPaneClosed(false);
    void chat?.newSession();
  };

  const navigate = useCallback((view: WorkspaceView, options: { preserveFocus?: boolean } = {}): void => {
    if (view === 'settings') setSettingsInitialCategory('agents');
    if (view === 'notes') { setSidebarPanel('memos'); setLeftSidebarOpen(true); return; }
    historyRequestId.current += 1;
    closeReview();
    if (view === 'explorer' || view === 'editor') {
      setSidebarPanel('files'); setLeftSidebarOpen(true);
      if (editorSplitOpen || (customLayout && splitPaneIds(customLayout).includes('editor'))) {
        focusWorkspacePane('editor');
        setCustomLayout(current => current && revealWorkspacePane(current, 'editor'));
        if (!customLayout && fullWidthViews.includes(activeView)) {
          editorReturnView.current = 'explorer';
          setActiveView('editor');
        }
        if (view === 'explorer' || customLayout) return;
      }
    }
    if (view === 'chat') { setSidebarPanel('chats'); setLeftSidebarOpen(true); }
    if (view === 'chats') { setSidebarPanel('agent-chats'); setLeftSidebarOpen(true); }
    if (view === 'chats' || view === 'docker') setWorkerView(view);
    if (view === 'git') { setSidebarPanel('github'); setLeftSidebarOpen(true); }
    const pane = view === 'terminal' ? 'terminal' : view === 'editor' ? 'editor'
      : view === 'chats' || view === 'docker' ? 'worker' : 'primary';
    if (!options.preserveFocus) focusWorkspacePane(pane);
    if (customLayout) {
      setCustomLayout(current => current && revealWorkspacePane(current, pane));
      if (pane === 'terminal' || pane === 'worker') return;
    }
    setActiveView(view);
    setPrimaryPaneClosed(false);
  }, [closeReview, editorSplitOpen, customLayout, focusWorkspacePane, activeView]);
  const openWorkerRoom = useCallback(() => navigate('chats'), [navigate]);
  const openGitChanges = useCallback(() => navigate('git'), [navigate]);
  const toggleRightSidebar = useCallback(() => setRightSidebarOpen(open => !open), []);

  useToolsMenu(navigate);

  const openLocalHistory = useCallback((path: string): void => {
    workerWorkspace.current?.closeHomies();
    setFileReview(null); setVerificationReview(null);
    setLineCommitTarget(null);
    setLocalHistoryPath(path);
    setRightSidebarOpen(true);
  }, []);

  const changeSearchQuery = (value: string): void => {
    historyRequestId.current += 1;
    setSearchQuery(value);
    setSubmittedSearchQuery('');
    historySearch.clear();
  };

  const submitHistorySearch = (refresh = false): void => {
    const query = searchQuery.trim();
    if (!query || workspace.accountSwitchPending) return;
    navigate('search');
    setSubmittedSearchQuery(query);
    void historySearch.search({ query, refresh, limit: 50 });
  };

  const replaceExplorerWithEditor = useCallback((): void => {
    editorReturnView.current = 'explorer';
    setCustomLayout(current => current && revealWorkspacePane(replaceWorkspacePane(current, 'primary', 'editor'), 'editor'));
    setPrimaryPaneClosed(false);
    setActiveView('editor');
    focusWorkspacePane('editor');
  }, [focusWorkspacePane]);

  const openWorkspaceFile = useCallback((path: string, line: number | null = null): void => {
    historyRequestId.current += 1;
    editorRequestId.current += 1;
    closeReview();
    focusWorkspacePane('editor');
    setEditorTarget({ path, line, requestId: editorRequestId.current });
    setEditorSplitOpen(true);
    if (activeView === 'explorer') {
      replaceExplorerWithEditor();
      return;
    }
    setCustomLayout(current => current && revealWorkspacePane(current, 'editor'));
    if (!customLayout && fullWidthViews.includes(activeView)) {
      editorReturnView.current = activeView;
      setPrimaryPaneClosed(false);
      setActiveView('editor');
    }
  }, [closeReview, focusWorkspacePane, activeView, replaceExplorerWithEditor, customLayout]);

  const closeEditorSplit = (): void => {
    setLineCommitTarget(null);
    setEditorSplitOpen(false);
    const returnToExplorer = activeView === 'editor' && editorReturnView.current === 'explorer';
    setCustomLayout(current => current && (returnToExplorer
      ? replaceWorkspacePane(current, 'editor', 'primary') : removeSplitPane(current, 'editor')));
    setPrimaryPaneClosed(false);
    setEditorTarget(null);
    if (activeView === 'editor') {
      if (editorReturnView.current === 'explorer') {
        setActiveView('explorer');
        focusWorkspacePane('primary');
        setSidebarPanel('files');
      } else navigate(editorReturnView.current);
    }
  };

  const handleWorkspaceEntryMutation = useCallback((mutation: WorkspaceEntryMutation): void => {
    editorMutationRequestId.current += 1;
    setEditorMutation({ ...mutation, requestId: editorMutationRequestId.current });
  }, []);
  const editorLayoutMode = activeView === 'editor' ? 'editor'
    : !editorSplitOpen ? 'primary'
      : fullWidthViews.includes(activeView) ? 'page'
        : primaryPaneClosed ? 'editor' : 'split';

  const workerPrimary = activeView === 'chats' || activeView === 'docker';
  const primaryView = workerPrimary ? 'chat' : activeView;
  const visiblePanes = splitPaneIds(customLayout ?? visibleWorkspaceLayout(editorLayoutMode, activeView === 'terminal', .5, workerPrimary));
  const visiblePaneKey = [...visiblePanes].sort().join(':');
  const selectedPane = visiblePanes.includes(focusedPane) ? focusedPane : visiblePanes[0];
  const railView = selectedPane === 'editor' ? 'editor' : selectedPane === 'terminal' ? 'terminal'
    : selectedPane === 'worker' ? workerView : primaryView;
  const automaticSidebarPanel = sidebarPanelForWorkspace(railView, visiblePanes);
  useEffect(() => window.workspaceSurface?.onCommand(command => {
    if (command.action === 'navigate') navigate(command.view as WorkspaceView);
    else if (command.action === 'sidebar') setLeftSidebarOpen(open => !open);
    else void cheshiDesktop?.workspaceManagement?.openManager().catch(console.error);
  }), [navigate]);
  const workspaceNeedsAttention = Object.values(workspace.controllers).some(controller => controller.state.approvals.length > 0);
  const sidebarScene = `${activeView}:${visiblePaneKey}`;
  const previousSidebarScene = useRef(sidebarScene);
  useEffect(() => {
    if (updateResume.editorSessionMode === 'waiting') return;
    const sceneChanged = previousSidebarScene.current !== sidebarScene;
    previousSidebarScene.current = sidebarScene;
    // Keep Explorer on ordinary startup; follow later scene changes and update recovery.
    if (!automaticSidebarPanel || (!sceneChanged && updateResume.editorSessionMode !== 'preserve')) return;
    setSidebarPanel(automaticSidebarPanel);
  }, [sidebarScene, automaticSidebarPanel, updateResume.editorSessionMode]);
  const closePane = (pane: 'primary' | 'terminal' | 'worker') => {
    if (customLayout) setCustomLayout(current => removeSplitPane(current, pane));
    else setPrimaryPaneClosed(true);
  };

  return (
    <ChatDraftAttachmentsContext.Provider value={draftAttachments}>
    <SidebarToggleVisibility.Provider value={reviewing}>
    <div ref={notificationSceneRef} className={`app-shell ${styles.shell}`} data-workspace-surface={window.workspaceSurface ? 'true' : undefined}>
      {window.workspaceSurface && <WorkspaceSurfaceReporter view={leftSidebarOpen && sidebarPanel === 'memos' ? 'notes' : railView}
        sidebarOpen={leftSidebarOpen} running={workspace.responseThreadIds.length} attention={workspaceNeedsAttention} />}
      {updateResume.error && <div role="alert">{updateResume.error}</div>}
      <div
        inert={updateResume.busy}
        className={`app-layout ${styles.layout}`}
        data-active-view={activeView}
        data-left-sidebar-open={leftSidebarOpen ? 'true' : 'false'}
        data-file-review={reviewing ? 'true' : undefined}
        data-right-sidebar-open={rightSidebarOpen && reviewing ? 'true' : 'false'}
      >
        {!window.workspaceSurface && <LiquidGlassPanel as="aside" className={styles.sidebarRail} aria-label="Application navigation">
          <SidebarRail activeView={leftSidebarOpen && sidebarPanel === 'memos' ? 'notes' : railView} sidebarOpen={leftSidebarOpen} onNavigate={navigate}
            onToggleSidebar={() => setLeftSidebarOpen(open => !open)} />
        </LiquidGlassPanel>}
        <MemoSidebar api={cheshiDesktop?.notes} target={memoSidebarTarget} />
        <SlidingSidePanel open={leftSidebarOpen} anchor="end" stageClassName={styles.sidebarPanelStage}
          id="workspace-sidebar" className={`sidebar-column ${styles.sidebarPanel}`}
          inert={workspace.accountSwitchPending}>
            <Sidebar
              memoPanelRef={setMemoSidebarTarget}
              chatsPanelRef={setChatsSidebarTarget}
              githubPanelRef={setGithubSidebarTarget}
              activePanel={sidebarPanel}
              onPanelChange={setSidebarPanel}
              chatPanel={<ChatSessionList
                search={<ChatHistorySearchBar query={searchQuery} disabled={workspace.accountSwitchPending}
                  onQueryChange={changeSearchQuery} onSubmit={() => submitHistorySearch()}
                  onFocus={() => { if (activeView !== 'search') navigate('search', { preserveFocus: true }); }} />}
                activeSessionId={chat?.state.activeSessionId ?? null}
                loading={workspace.sessionHistory.loading}
                newChatDisabled={chatSessionSelectionDisabled}
                responseThreadIds={workspace.responseThreadIds}
                selectionDisabled={chatSessionSelectionDisabled}
                sessions={workspace.sessionHistory.sessions}
                onNew={newChat}
                onRefresh={chat?.refreshSessions}
                refreshDisabled={workspace.accountSwitchPending || workspace.deletePending}
                refreshError={workspace.sessionHistory.error}
                onTemporaryChat={() => { if (!workspace.accountSwitchPending) void cheshiDesktop?.temporaryChat.openWindow().catch(error => window.alert(String(error))); }}
                temporaryChatOpen={temporaryChatOpen}
                onOpen={openChat}
                onRenamingChange={setRenamingSession}
                onRename={cheshiDesktop?.renameCodexChatSession ? (sessionId, title) => {
                  if (!cheshiDesktop?.renameCodexChatSession) throw new Error('Session renaming is unavailable. Restart Cheshi.');
                  return cheshiDesktop.renameCodexChatSession(sessionId, title, workspace.activePaneId);
                } : undefined}
                deleteReason={workspace.deleteSessionReason}
                onDelete={(sessionId) => {
                  if (workspace.deleteSessionReason(sessionId)) return;
                  workspace.dismissError();
                  chat?.dismissError();
                  setDeleteChoice({ sessionId, title: chat?.state.sessions.find((session) => session.id === sessionId)?.title ?? sessionId });
                }}
              />}
              selectedFilePath={localHistoryPath ?? editorSelectedPath}
              onWorkspaceEntryMutation={handleWorkspaceEntryMutation}
              onOpenWorkspaceFile={openWorkspaceFile}
              onOpenLocalHistory={openLocalHistory}
            />
        </SlidingSidePanel>
        <div className="workspace-column" inert={workspace.accountSwitchPending}>
          <WorkspaceEditorSplit mode={editorLayoutMode} layout={customLayout} onLayoutChange={setCustomLayout}
            onPaneActivate={setFocusedPane} focusRequest={paneFocusRequest}
            minimumPrimaryWidth={primaryView === 'chat' ? CHAT_PANE_MIN_WIDTH : undefined}
            terminalPrimary={activeView === 'terminal'} workerPrimary={workerPrimary} disabled={updateResume.busy || workspace.accountSwitchPending}
            onOpenPane={pane => {
              focusWorkspacePane(pane);
              if (pane === 'editor') setEditorSplitOpen(true);
              if (pane === 'primary') { setActiveView('chat'); setPrimaryPaneClosed(false); }
              if (pane === 'worker') setWorkerView('chats');
            }}
            worker={<WorkerWorkspace ref={workerWorkspace} view={visiblePanes.includes('worker') ? workerView : null}
              onCloseWorkspace={visiblePanes.length > 1 ? () => closePane('worker') : undefined}
              onBeforeOpenHomies={closeReview}
              reviewedVerificationId={verificationReview?.id} onReviewVerification={openVerificationReview}
              reviewedMessageId={fileReview?.item?.id} onReviewFileChanges={openChatsFileReview}
              sidebarTarget={chatsSidebarTarget} sidebarActive={sidebarPanel === 'agent-chats' && leftSidebarOpen}
              onOpenRoom={openWorkerRoom} />}
            terminal={<TerminalWorkspace
              active={visiblePanes.includes('terminal')}
              onCloseWorkspace={visiblePanes.length > 1 ? () => closePane('terminal') : undefined}
              blocked={updateResume.busy || fileSearchOpen}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen(open => !open)}
            />} editor={
            <WorkspaceEditor
              sessionMode={updateResume.editorSessionMode}
              onSessionRestored={() => {
                setEditorSplitOpen(true);
                if (activeView === 'explorer') replaceExplorerWithEditor();
              }}
              active={visiblePanes.includes('editor')}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={editorLayoutMode === 'editor'
                ? () => setRightSidebarOpen((open) => !open) : undefined}
              mutation={editorMutation}
              target={editorTarget}
              onAllTabsClosed={closeEditorSplit}
              onSelectedPathChange={setEditorSelectedPath}
              onDirtyPathsChange={setEditorDirtyPaths}
              onOpenLocalHistory={openLocalHistory}
              onShowLineCommit={openLineCommit}
            />
          }>
          {primaryView === 'explorer' && <ExplorerView />}
          {primaryView === 'search' && <ChatHistorySearchPage query={submittedSearchQuery}
            result={historySearch.result} loading={historySearch.loading} error={historySearch.error}
            loadingMore={historySearch.loadingMore} moreError={historySearch.moreError} onLoadMore={historySearch.loadMore}
            selectionDisabled={chatSessionSelectionDisabled} onOpen={openHistorySearchHit}
            onRefresh={() => submitHistorySearch(true)} onClose={() => navigate('chat')}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)} />}
          {primaryView === 'blank' && <WindowTabs />}
          {primaryView === 'calendar' && <CalendarView rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)} />}
          {primaryView === 'voice' && <VoiceView
            onOpenSettings={() => { navigate('settings'); setSettingsInitialCategory('voice'); }}
            onCloseWorkspace={visiblePanes.length > 1 ? () => closePane('primary') : undefined} />}
          <FlashSourceNavigationContext.Provider value={openHistorySearchHit}>
            <ChatWorkspace
              workspace={workspace}
              active={primaryView === 'chat' && visiblePanes.includes('primary')}
              onCloseWorkspace={visiblePanes.length > 1 ? () => closePane('primary') : undefined}
              sessionSyncEnabled={workspace.sessionHistory.loading || sidebarPanel === 'chats'}
              onReviewFileChanges={openFileReview}
              historyTarget={historyTarget}
              onHistoryTargetHandled={handleHistoryTarget}
            />
          </FlashSourceNavigationContext.Provider>
          {primaryView === 'codegraph' && (
            <CodeGraphView
              index={codeGraphIndex}
              onCloseWorkspace={visiblePanes.length > 1 ? () => closePane('primary') : undefined}
              onOpenWorkspaceFile={openWorkspaceFile}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            />
          )}
            <GitWorkspace
              active={primaryView === 'git'}
              sidebarTarget={githubSidebarTarget} onOpenChanges={openGitChanges}
              onOpenWorkspaceFile={openWorkspaceFile}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={toggleRightSidebar}
            />
          {primaryView === 'plugins' && (
            <PluginsView
              chatContextId={workspace.activePaneId}
              onOpenChat={openWorkflowChat}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            />
          )}
          {primaryView === 'settings' && <SettingsView initialCategory={settingsInitialCategory} contextId={workspace.activePaneId} onOpenChat={openWorkflowChat} />}
          {primaryView === 'blank' && <BlankView />}
          </WorkspaceEditorSplit>
        </div>
        <ReviewSidebar
          onOpenFile={verificationReview ? undefined : openWorkspaceFile}
          verification={verificationReview}
          open={rightSidebarOpen}
          item={reviewedItem}
          initialPath={fileReview?.path ?? null}
          onCloseReview={closeReview}
          lineCommit={lineCommitTarget}
          localHistoryPath={localHistoryPath}
          localHistoryDirty={localHistoryPath !== null && editorDirtyPaths.includes(localHistoryPath)}
        />
      </div>
      <WorkspaceStatusBar onAccountInitialLoad={accountReady}
        selectionDisabledReason={accountSwitchReason}
        onBeforeSelect={beforeAccountSelect} onSelectionFinished={accountSelectionFinished} />
      {fileSearchOpen && <WorkspaceFileSearch onOpenFile={openWorkspaceFile} onClose={() => setFileSearchOpen(false)} />}
      <DiscordSetupConfirmation api={cheshiDesktop?.discord} />
      {deleteChoice && <ChatDeleteSessionDialog sessionTitle={deleteChoice.title}
        reason={workspace.deletePending ? null : workspace.deleteSessionReason(deleteChoice.sessionId)}
        pending={workspace.deletePending} error={workspace.error ?? chat?.state.error ?? null}
        onDelete={() => workspace.deleteSession(deleteChoice.sessionId)}
        onDeleted={() => { setDeleteChoice(null); closeReview(); }}
        onClose={() => setDeleteChoice(null)} />}
      {historyChoice && <ChatHistoryOpenDialog workspace={workspace} sessionId={historyChoice.sessionId}
        sessionTitle={historyChoice.title} paneId={historyChoice.paneId}
        onResume={() => workspace.openSession(historyChoice.sessionId)}
        onOpened={() => {
          setHistoryChoice(null); closeReview(); setActiveView('chat'); setPrimaryPaneClosed(false);
          setCustomLayout(current => current && revealWorkspacePane(current, 'primary'));
        }}
        onClose={() => setHistoryChoice(null)} />}
    </div>
      <RegionalBlur sourceRef={notificationSceneRef}>
        <SchedulerNotifications onOpenThread={id => {
          if (!chatSessionSelectionDisabled && !updateResume.busy) void openWorkflowChat(id);
        }} />
      </RegionalBlur>
    </SidebarToggleVisibility.Provider>
    </ChatDraftAttachmentsContext.Provider>
  );
}
