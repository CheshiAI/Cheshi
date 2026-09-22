import { useCallback, useEffect, useRef, useState } from 'react';

import { LiquidGlassPanel, SidebarToggleVisibility, SlidingSidePanel } from '../../shared/ui';
import type { WorkspaceEntryMutation } from '../../cheshiDesktop';
import {
  ChatSessionList,
  type ChatActivityItem,
} from '../chat';
import { ChatWorkspace } from '../chat/ChatWorkspace';
import { TemporaryChatPanel } from '../chat/TemporaryChatPanel';
import { ChatDeleteSessionDialog } from '../chat/ChatDeleteSessionDialog';
import { ChatHistoryOpenDialog } from '../chat/ChatHistoryOpenDialog';
import { ChatHistorySearchBar } from '../chat/ChatHistorySearchBar';
import { ChatHistorySearchPage } from '../chat/ChatHistorySearchPage';
import { useChatHistorySearch } from '../chat/useChatHistorySearch';
import type { ChatHistorySearchHit } from '../../../../shared/chat-history-search';
import type { GitLineBlameRequest } from '../../../../shared/git-line-blame';
import type { ChatHistorySearchTarget } from '../chat/chatHistorySearchNavigation';
import { HistoryRecallNavigation } from '../chat/HistoryRecallActivity';
import { useChatWorkspace } from '../chat/useChatWorkspace';
import { WindowTabs } from '../chrome/WindowChrome';
import {
  WorkspaceEditor,
  type WorkspaceEditorMutation,
  type WorkspaceEditorTarget,
} from '../editor';
import { GitWorkspace } from '../git';
import { CodeGraphView } from '../graph';
import { BlankView } from '../home/BlankView';
import { Sidebar, type WorkspaceView } from '../navigation/Sidebar';
import { SidebarRail } from '../navigation/SidebarRail';
import { PluginsView } from '../plugins';
import { TerminalWorkspace } from '../terminal';
import { SettingsView } from '../settings/SettingsView';
import { ReviewSidebar } from './ReviewSidebar';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';
import styles from './AppShell.module.css';
import { useAppUpdateResume } from './useAppUpdateResume';
import { WorkspaceEditorSplit } from './WorkspaceEditorSplit';
import { WorkspaceFileSearch } from '../navigation/WorkspaceFileSearch';
import { installFileSearchShortcut } from '../navigation/fileSearchShortcut';
import { ChatDraftAttachmentsContext, createChatDraftAttachments } from '../chat/chatDraftAttachments';
import { NotesView } from '../notes/NotesView';
import { MailView } from '../mail/MailView';
import { CalendarView } from '../calendar/CalendarView';
import { appleNoteAttachment } from '../notes/appleNotesModel';
import type { AppleNote } from '../../../../shared/apple-notes';
import { useSidebarResize } from './useSidebarResize';

const fullWidthViews: readonly WorkspaceView[] = ['git', 'plugins', 'notes', 'calendar', 'mail', 'settings'];

export function AppShell() {
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [temporaryChatOpen, setTemporaryChatOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState('');
  const [historyTarget, setHistoryTarget] = useState<ChatHistorySearchTarget | null>(null);
  const historyRequestId = useRef(0);
  const handleHistoryTarget = useCallback((requestId: number) => {
    setHistoryTarget((current) => current?.requestId === requestId ? null : current);
  }, []);
  const [indexLoaded, setIndexLoaded] = useState(false);
  const accountReady = useCallback(() => setAccountLoaded(true), []);
  const indexReady = useCallback(() => setIndexLoaded(true), []);
  const startupReported = useRef(false);
  const [activeView, setActiveView] = useState<WorkspaceView>('chat');
  const [historyChoice, setHistoryChoice] = useState<{ sessionId: string; title: string; paneId: string } | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<{ sessionId: string; title: string } | null>(null);
  const [fileReview, setFileReview] = useState<{ paneId: string; itemId: string; path: string | null } | null>(null);
  const [lineCommitTarget, setLineCommitTarget] = useState<GitLineBlameRequest | null>(null);
  const [localHistoryPath, setLocalHistoryPath] = useState<string | null>(null);
  const closeReview = useCallback(() => { setFileReview(null); setLineCommitTarget(null); setLocalHistoryPath(null); }, []);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [sidebarPanel, setSidebarPanel] = useState<'files' | 'chats'>('files');
  const openFileReview = useCallback((paneId: string, itemId: string, path?: string) => {
    setLineCommitTarget(null);
    setLocalHistoryPath(null);
    setRightSidebarOpen(true);
    setFileReview({ paneId, itemId, path: path ?? null });
  }, []);
  const openLineCommit = useCallback((request: GitLineBlameRequest) => {
    setFileReview(null);
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
  const attachmentDestination = useRef({ activeView, paneId: workspace.activePaneId });
  attachmentDestination.current = { activeView, paneId: workspace.activePaneId };
  const historySearch = useChatHistorySearch(workspace.activePaneId);
  const updateResume = useAppUpdateResume({ activeView, rightSidebarOpen, setActiveView, setRightSidebarOpen, sidebarPanel, setSidebarPanel,
    blockedReason: temporaryChatOpen ? 'Close the temporary chat before updating.'
      : historyChoice || deleteChoice ? 'Close the conversation dialog before updating.' : null });
  const accountSwitchReason = updateResume.busy ? 'Wait for update preparation or workspace recovery to finish.' : temporaryChatOpen ? 'Close the temporary chat before switching accounts.'
    : historyChoice || deleteChoice ? 'Close the conversation dialog before switching accounts.'
      : workspace.accountSwitchReason;
  const beforeAccountSelect = (): string | null => accountSwitchReason ?? workspace.beginAccountSwitch();
  const accountSelectionFinished = (changed: boolean, preserveConversation = false): void => {
    workspace.completeAccountSwitch(changed, preserveConversation);
    if (changed) {
      historyRequestId.current += 1;
      historySearch.clear();
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
  const reviewedItem = (fileReview ? workspace.controllers[fileReview.paneId]?.state.items : [])
    ?.find((item): item is ChatActivityItem => (
      item.kind === 'activity' && item.activity === 'files' && item.id === fileReview?.itemId
    )) ?? null;
  const reviewing = Boolean(reviewedItem || lineCommitTarget || localHistoryPath !== null);
  const sidebarResize = useSidebarResize({ rightOpen: false,
    reviewing: rightSidebarOpen && reviewing, disabled: updateResume.busy || workspace.accountSwitchPending });

  const openChat = (sessionId: string): void => {
    if (chatSessionSelectionDisabled) return;
    workspace.dismissError();
    setHistoryChoice({ sessionId, title: chat?.state.sessions.find((session) => session.id === sessionId)?.title ?? sessionId,
      paneId: workspace.activePaneId });
  };

  const openWorkflowChat = (threadId: string): void => {
    if (workspace.deletePending) return;
    historyRequestId.current += 1;
    closeReview();
    setActiveView('chat');
    setPrimaryPaneClosed(false);
    void chat?.openSession(threadId);
  };

  const openHistorySearchHit = async (hit: Pick<ChatHistorySearchHit, 'threadId' | 'itemId'>): Promise<boolean> => {
    if (chatSessionSelectionDisabled || updateResume.busy || workspace.relay.running) return false;
    const requestId = ++historyRequestId.current;
    workspace.dismissError();
    const opened = await workspace.openSession(hit.threadId);
    if (!opened || requestId !== historyRequestId.current) return false;
    closeReview();
    setActiveView('chat');
    setPrimaryPaneClosed(false);
    setHistoryTarget({ threadId: hit.threadId, itemId: hit.itemId, requestId });
    return true;
  };

  const newChat = (): void => {
    if (workspace.deletePending) return;
    historyRequestId.current += 1;
    closeReview();
    setActiveView('chat');
    setPrimaryPaneClosed(false);
    void chat?.newSession();
  };

  const navigate = (view: WorkspaceView): void => {
    historyRequestId.current += 1;
    closeReview();
    setActiveView(view);
    setPrimaryPaneClosed(false);
  };

  const attachNote = async (note: AppleNote): Promise<boolean> => {
    if (chatSessionSelectionDisabled || updateResume.busy || workspace.relay.running) return false;
    const destination = attachmentDestination.current;
    const requestId = historyRequestId.current;
    const attached = await draftAttachments.attach(destination.paneId, [appleNoteAttachment(note)]);
    if (attached && historyRequestId.current === requestId && attachmentDestination.current.activeView === 'notes'
      && attachmentDestination.current.paneId === destination.paneId) navigate('chat');
    return attached;
  };

  const openLocalHistory = (path: string): void => {
    setFileReview(null);
    setLineCommitTarget(null);
    setLocalHistoryPath(path);
    setRightSidebarOpen(true);
  };

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

  const openWorkspaceFile = (path: string, line: number | null = null): void => {
    historyRequestId.current += 1;
    editorRequestId.current += 1;
    closeReview();
    setEditorTarget({ path, line, requestId: editorRequestId.current });
    setEditorSplitOpen(true);
    if (fullWidthViews.includes(activeView)) {
      editorReturnView.current = activeView;
      setPrimaryPaneClosed(false);
      setActiveView('editor');
    }
  };

  const closeEditorSplit = (): void => {
    setLineCommitTarget(null);
    setEditorSplitOpen(false);
    setPrimaryPaneClosed(false);
    setEditorTarget(null);
    if (activeView === 'editor') navigate(editorReturnView.current);
  };

  const handleWorkspaceEntryMutation = (mutation: WorkspaceEntryMutation): void => {
    editorMutationRequestId.current += 1;
    setEditorMutation({ ...mutation, requestId: editorMutationRequestId.current });
  };
  const editorLayoutMode = activeView === 'editor' ? 'editor'
    : !editorSplitOpen ? 'primary'
      : fullWidthViews.includes(activeView) ? 'page'
        : primaryPaneClosed ? 'editor' : 'split';

  return (
    <ChatDraftAttachmentsContext.Provider value={draftAttachments}>
    <SidebarToggleVisibility.Provider value={reviewing}>
    <div className={`app-shell ${styles.shell}`}>
      {updateResume.error && <div role="alert">{updateResume.error}</div>}
      <div
        inert={updateResume.busy}
        className={`app-layout ${styles.layout}`}
        ref={sidebarResize.layoutRef}
        style={sidebarResize.style}
        data-sidebar-resizing={sidebarResize.resizing ?? undefined}
        data-active-view={activeView}
        data-left-sidebar-open={leftSidebarOpen ? 'true' : 'false'}
        data-file-review={reviewedItem || lineCommitTarget || localHistoryPath !== null ? 'true' : undefined}
        data-right-sidebar-open={rightSidebarOpen && reviewing ? 'true' : 'false'}
      >
        <LiquidGlassPanel as="aside" className={styles.sidebarRail} aria-label="Application navigation">
          <SidebarRail activeView={activeView} sidebarOpen={leftSidebarOpen} onNavigate={navigate}
            onToggleSidebar={() => setLeftSidebarOpen(open => !open)} />
        </LiquidGlassPanel>
        <SlidingSidePanel open={leftSidebarOpen} anchor="end" stageClassName={styles.sidebarPanelStage}
          id="workspace-sidebar" className={`sidebar-column ${styles.sidebarPanel}`}
          inert={workspace.accountSwitchPending}>
            <Sidebar
              activePanel={sidebarPanel}
              onPanelChange={setSidebarPanel}
              chatPanel={<ChatSessionList
                search={<ChatHistorySearchBar query={searchQuery} disabled={workspace.accountSwitchPending}
                  onQueryChange={changeSearchQuery} onSubmit={() => submitHistorySearch()}
                  onFocus={() => { if (activeView !== 'search') navigate('search'); }} />}
                activeSessionId={chat?.state.activeSessionId ?? null}
                loading={workspace.sessionHistory.loading}
                newChatDisabled={chatSessionSelectionDisabled}
                responseThreadIds={workspace.responseThreadIds}
                selectionDisabled={chatSessionSelectionDisabled}
                sessions={workspace.sessionHistory.sessions}
                onNew={newChat}
                onTemporaryChat={() => { if (!workspace.accountSwitchPending) setTemporaryChatOpen(true); }}
                temporaryChatOpen={temporaryChatOpen}
                onOpen={openChat}
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
        <div hidden={!leftSidebarOpen} className={`${styles.sidebarResizer} ${styles.leftResizer}`}
          {...sidebarResize.separatorProps('left')} />
        <div className="workspace-column" inert={workspace.accountSwitchPending}>
          <WorkspaceEditorSplit mode={editorLayoutMode} editor={
            <WorkspaceEditor
              sessionMode={updateResume.editorSessionMode}
              onSessionRestored={() => setEditorSplitOpen(true)}
              active={editorLayoutMode === 'split' || editorLayoutMode === 'editor'}
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
          {activeView === 'search' && <ChatHistorySearchPage query={submittedSearchQuery}
            result={historySearch.result} loading={historySearch.loading} error={historySearch.error}
            selectionDisabled={chatSessionSelectionDisabled} onOpen={openHistorySearchHit}
            onRefresh={() => submitHistorySearch(true)} onClose={() => navigate('chat')}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)} />}
          {activeView === 'blank' && <WindowTabs />}
          {activeView === 'mail' && <MailView rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)} />}
          {activeView === 'calendar' && <CalendarView rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)} />}
          {activeView === 'notes' && <NotesView onAttach={attachNote}
            attachmentDisabled={chatSessionSelectionDisabled || updateResume.busy || workspace.relay.running}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)} />}
          <HistoryRecallNavigation.Provider value={{ open: openHistorySearchHit,
            disabled: chatSessionSelectionDisabled || updateResume.busy || workspace.relay.running || workspace.responseThreadIds.length > 0 }}>
            <ChatWorkspace
              workspace={workspace}
              active={activeView === 'chat' && !primaryPaneClosed}
              onCloseWorkspace={editorSplitOpen ? () => setPrimaryPaneClosed(true) : undefined}
              sessionSyncEnabled={workspace.sessionHistory.loading || sidebarPanel === 'chats'}
              onReviewFileChanges={openFileReview}
              historyTarget={historyTarget}
              onHistoryTargetHandled={handleHistoryTarget}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            />
          </HistoryRecallNavigation.Provider>
          {activeView === 'codegraph' && (
            <CodeGraphView
              onCloseWorkspace={editorSplitOpen ? () => setPrimaryPaneClosed(true) : undefined}
              onOpenWorkspaceFile={openWorkspaceFile}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            />
          )}
          {activeView === 'git' && (
            <GitWorkspace
              onOpenWorkspaceFile={openWorkspaceFile}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            />
          )}
          {activeView === 'plugins' && (
            <PluginsView
              chatContextId={workspace.activePaneId}
              onOpenChat={openWorkflowChat}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            />
          )}
          {activeView === 'settings' && <SettingsView />}
          <TerminalWorkspace
            active={activeView === 'terminal' && !primaryPaneClosed}
            onCloseWorkspace={editorSplitOpen ? () => setPrimaryPaneClosed(true) : undefined}
            blocked={fileSearchOpen}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
          />
          {activeView === 'blank' && <BlankView />}
          </WorkspaceEditorSplit>
        </div>
        <ReviewSidebar
          open={rightSidebarOpen}
          item={reviewedItem}
          initialPath={fileReview?.path ?? null}
          onCloseReview={closeReview}
          lineCommit={lineCommitTarget}
          localHistoryPath={localHistoryPath}
          localHistoryDirty={localHistoryPath !== null && editorDirtyPaths.includes(localHistoryPath)}
        />
      </div>
      <WorkspaceStatusBar onAccountInitialLoad={accountReady} onIndexInitialLoad={indexReady}
        selectionDisabledReason={accountSwitchReason}
        onBeforeSelect={beforeAccountSelect} onSelectionFinished={accountSelectionFinished} />
      {temporaryChatOpen && <TemporaryChatPanel onClose={() => setTemporaryChatOpen(false)} />}
      {fileSearchOpen && <WorkspaceFileSearch onOpenFile={openWorkspaceFile} onClose={() => setFileSearchOpen(false)} />}
      {deleteChoice && <ChatDeleteSessionDialog sessionTitle={deleteChoice.title}
        reason={workspace.deletePending ? null : workspace.deleteSessionReason(deleteChoice.sessionId)}
        pending={workspace.deletePending} error={workspace.error ?? chat?.state.error ?? null}
        onDelete={() => workspace.deleteSession(deleteChoice.sessionId)}
        onDeleted={() => { setDeleteChoice(null); closeReview(); }}
        onClose={() => setDeleteChoice(null)} />}
      {historyChoice && <ChatHistoryOpenDialog workspace={workspace} sessionId={historyChoice.sessionId}
        sessionTitle={historyChoice.title} paneId={historyChoice.paneId}
        onResume={() => workspace.openSession(historyChoice.sessionId)}
        onOpened={() => { setHistoryChoice(null); closeReview(); setActiveView('chat'); setPrimaryPaneClosed(false); }}
        onClose={() => setHistoryChoice(null)} />}
    </div>
    </SidebarToggleVisibility.Provider>
    </ChatDraftAttachmentsContext.Provider>
  );
}
