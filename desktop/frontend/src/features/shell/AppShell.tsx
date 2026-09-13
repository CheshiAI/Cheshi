import { useCallback, useEffect, useRef, useState } from 'react';

import { LiquidGlassPanel } from '../../shared/ui';
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
import type { ChatHistorySearchTarget } from '../chat/chatHistorySearchNavigation';
import { useChatWorkspace } from '../chat/useChatWorkspace';
import { WindowChrome, WindowTabs } from '../chrome/WindowChrome';
import {
  WorkspaceEditor,
  type WorkspaceEditorMutation,
  type WorkspaceEditorTarget,
} from '../editor';
import { GitWorkspace } from '../git';
import { CodeGraphView } from '../graph';
import { BlankView } from '../home/BlankView';
import { Sidebar, type WorkspaceView } from '../navigation/Sidebar';
import { PluginsView } from '../plugins';
import { TerminalWorkspace } from '../terminal';
import { ShowcaseView } from '../showcase/ShowcaseView';
import { ReviewSidebar } from './ReviewSidebar';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';
import { LocalHistoryPage } from '../editor/LocalHistoryPage';
import styles from './AppShell.module.css';
import { useAppUpdateResume } from './useAppUpdateResume';

export function AppShell() {
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [temporaryChatOpen, setTemporaryChatOpen] = useState(false);
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
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const openFileReview = useCallback((paneId: string, itemId: string, path?: string) => {
    setRightSidebarOpen(true);
    setFileReview({ paneId, itemId, path: path ?? null });
  }, []);
  const [editorTarget, setEditorTarget] = useState<WorkspaceEditorTarget | null>(null);
  const [editorMutation, setEditorMutation] = useState<WorkspaceEditorMutation | null>(null);
  const [editorSelectedPath, setEditorSelectedPath] = useState<string | null>(null);
  const [localHistoryPath, setLocalHistoryPath] = useState<string | null>(null);
  const localHistoryReturnView = useRef<WorkspaceView>('chat');
  const [editorDirtyPaths, setEditorDirtyPaths] = useState<string[]>([]);
  const editorRequestId = useRef(0);
  const editorMutationRequestId = useRef(0);
  const workspace = useChatWorkspace();
  const historySearch = useChatHistorySearch(workspace.activePaneId);
  const updateResume = useAppUpdateResume({ activeView, rightSidebarOpen, setActiveView, setRightSidebarOpen,
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
      setFileReview(null); setHistoryChoice(null); setDeleteChoice(null); setHistoryTarget(null);
    }
  };
  const chat = workspace.activeController;
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

  const openChat = (sessionId: string): void => {
    if (chatSessionSelectionDisabled) return;
    workspace.dismissError();
    setHistoryChoice({ sessionId, title: chat?.state.sessions.find((session) => session.id === sessionId)?.title ?? sessionId,
      paneId: workspace.activePaneId });
  };

  const openWorkflowChat = (threadId: string): void => {
    if (workspace.deletePending) return;
    historyRequestId.current += 1;
    setFileReview(null);
    setActiveView('chat');
    void chat?.openSession(threadId);
  };

  const openHistorySearchHit = async (hit: ChatHistorySearchHit): Promise<boolean> => {
    if (chatSessionSelectionDisabled) return false;
    const requestId = ++historyRequestId.current;
    workspace.dismissError();
    const opened = await workspace.openSession(hit.threadId);
    if (!opened || requestId !== historyRequestId.current) return false;
    setFileReview(null);
    setActiveView('chat');
    setHistoryTarget({ threadId: hit.threadId, itemId: hit.itemId, requestId });
    return true;
  };

  const newChat = (): void => {
    if (workspace.deletePending) return;
    historyRequestId.current += 1;
    setFileReview(null);
    setActiveView('chat');
    void chat?.newSession();
  };

  const navigate = (view: WorkspaceView): void => {
    historyRequestId.current += 1;
    setFileReview(null);
    setActiveView(view);
  };

  const openLocalHistory = (path: string): void => {
    if (activeView !== 'local-history') localHistoryReturnView.current = activeView;
    setLocalHistoryPath(path);
    navigate('local-history');
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
    setFileReview(null);
    setEditorTarget({ path, line, requestId: editorRequestId.current });
    setRightSidebarOpen(true);
    setActiveView('editor');
  };

  const handleWorkspaceEntryMutation = (mutation: WorkspaceEntryMutation): void => {
    editorMutationRequestId.current += 1;
    setEditorMutation({ ...mutation, requestId: editorMutationRequestId.current });
  };

  return (
    <div className={`app-shell ${styles.shell}`}>
      {updateResume.error && <div role="alert">{updateResume.error}</div>}
      <div
        inert={updateResume.busy}
        className={`app-layout ${styles.layout}`}
        data-active-view={activeView}
        data-file-review={reviewedItem ? 'true' : undefined}
        data-right-sidebar-open={rightSidebarOpen ? 'true' : 'false'}
      >
        <LiquidGlassPanel className="sidebar-column" inert={workspace.accountSwitchPending}>
          <WindowChrome />
          <Sidebar
            search={<ChatHistorySearchBar query={searchQuery} disabled={workspace.accountSwitchPending}
              onQueryChange={changeSearchQuery} onSubmit={() => submitHistorySearch()}
              onFocus={() => { if (activeView !== 'search') navigate('search'); }} />}
            activeView={activeView}
            selectedFilePath={activeView === 'local-history' ? localHistoryPath : editorSelectedPath}
            onNavigate={navigate}
            onWorkspaceEntryMutation={handleWorkspaceEntryMutation}
            onOpenWorkspaceFile={openWorkspaceFile}
            onOpenLocalHistory={openLocalHistory}
          />
        </LiquidGlassPanel>
        <div className="workspace-column" inert={workspace.accountSwitchPending}>
          {activeView === 'search' && <ChatHistorySearchPage query={submittedSearchQuery}
            result={historySearch.result} loading={historySearch.loading} error={historySearch.error}
            selectionDisabled={chatSessionSelectionDisabled} onOpen={openHistorySearchHit}
            onRefresh={() => submitHistorySearch(true)} onClose={() => navigate('chat')}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)} />}
          {activeView === 'blank' && <WindowTabs />}
          <ChatWorkspace
            workspace={workspace}
            active={activeView === 'chat'}
            sessionSyncEnabled={rightSidebarOpen && !fileReview}
            onReviewFileChanges={openFileReview}
            historyTarget={historyTarget}
            onHistoryTargetHandled={handleHistoryTarget}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
          />
          {activeView === 'codegraph' && (
            <CodeGraphView
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
          {activeView === 'local-history' && localHistoryPath && (
            <LocalHistoryPage key={localHistoryPath} path={localHistoryPath}
              draftDirty={editorDirtyPaths.includes(localHistoryPath)}
              rightSidebarOpen={rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
              onClose={() => navigate(localHistoryReturnView.current)} />
          )}
          <WorkspaceEditor
            active={activeView === 'editor'}
            mutation={editorMutation}
            target={editorTarget}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
            onAllTabsClosed={() => navigate('chat')}
            onSelectedPathChange={setEditorSelectedPath}
            onDirtyPathsChange={setEditorDirtyPaths}
            onOpenLocalHistory={openLocalHistory}
          />
          <ShowcaseView active={activeView === 'showcase'}
            blocked={temporaryChatOpen || !!historyChoice || !!deleteChoice || workspace.accountSwitchPending}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)} />
          <TerminalWorkspace
            active={activeView === 'terminal'}
            rightSidebarOpen={rightSidebarOpen}
            onToggleRightSidebar={() => setRightSidebarOpen((currentOpen) => !currentOpen)}
          />
          {activeView === 'blank' && <BlankView />}
        </div>
        <ReviewSidebar
          open={rightSidebarOpen}
          item={reviewedItem}
          initialPath={fileReview?.path ?? null}
          onCloseReview={() => setFileReview(null)}
        >
          <ChatSessionList
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
          />
        </ReviewSidebar>
      </div>
      <WorkspaceStatusBar onAccountInitialLoad={accountReady} onIndexInitialLoad={indexReady}
        selectionDisabledReason={accountSwitchReason}
        onBeforeSelect={beforeAccountSelect} onSelectionFinished={accountSelectionFinished} />
      {temporaryChatOpen && <TemporaryChatPanel onClose={() => setTemporaryChatOpen(false)} />}
      {deleteChoice && <ChatDeleteSessionDialog sessionTitle={deleteChoice.title}
        reason={workspace.deletePending ? null : workspace.deleteSessionReason(deleteChoice.sessionId)}
        pending={workspace.deletePending} error={workspace.error ?? chat?.state.error ?? null}
        onDelete={() => workspace.deleteSession(deleteChoice.sessionId)}
        onDeleted={() => { setDeleteChoice(null); setFileReview(null); }}
        onClose={() => setDeleteChoice(null)} />}
      {historyChoice && <ChatHistoryOpenDialog workspace={workspace} sessionId={historyChoice.sessionId}
        sessionTitle={historyChoice.title} paneId={historyChoice.paneId}
        onResume={() => workspace.openSession(historyChoice.sessionId)}
        onOpened={() => { setHistoryChoice(null); setFileReview(null); setActiveView('chat'); }}
        onClose={() => setHistoryChoice(null)} />}
    </div>
  );
}
