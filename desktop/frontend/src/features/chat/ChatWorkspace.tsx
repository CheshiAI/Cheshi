import { WorkspaceLayoutControls, WorkspacePaneVisibilityContext } from '../shell/WorkspaceLayoutControls';
import { ArrowLeft, Columns2, PanelRight, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chatRelayContextIds } from '../../../../shared/chat-relay';
import {
  SidebarToggle,
  LiquidGlassPanel, NeumorphicButton, TwoTierHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ChatPaneViewport } from './ChatPaneViewport';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { ChatView } from './ChatView';
import { ChatErrorNotice } from './ChatErrorNotice';
import { ChatPaneIcon } from './ChatPaneIcon';
import { ChatRelayButton, ChatRelayStatus } from './ChatRelayControls';
import { ChatRelayHistoryPanel } from './ChatRelayHistoryPanel';
import { ChatSplitDialog } from './ChatSplitDialog';
import { CHAT_PANE_LIMIT } from './chatWorkspaceModel';
import { useChatController } from './useChatController';
import type { ChatWorkspaceController } from './useChatWorkspace';
import type { ChatHistorySearchNavigation } from './chatHistorySearchNavigation';
import viewStyles from './ChatView.module.css';
import styles from './ChatWorkspace.module.css';

interface ChatWorkspaceProps extends ChatHistorySearchNavigation {
  workspace: ChatWorkspaceController;
  active: boolean;
  rightSidebarOpen: boolean;
  sessionSyncEnabled: boolean;
  onToggleRightSidebar: () => void;
  onCloseWorkspace?: () => void;
  onReviewFileChanges: (paneId: string, itemId: string, path?: string) => void;
}

function PaneMount({ host, paneId }: { host: HTMLDivElement; paneId: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const hostClassName = styles.host ?? '';
  // CSS module names can change during HMR while the portal host stays alive.
  useLayoutEffect(() => {
    host.className = hostClassName;
  }, [host, hostClassName]);
  useLayoutEffect(() => {
    mountRef.current?.append(host);
    return () => host.remove();
  }, [host]);
  return <div className={styles.mount} data-chat-pane-mount={paneId} ref={mountRef} />;
}

function ChatPane({
  paneId, host, workspace, active, sessionSyncEnabled, onReviewFileChanges, historyTarget, onHistoryTargetHandled,
}: Pick<ChatWorkspaceProps, 'workspace' | 'active' | 'sessionSyncEnabled' | 'onReviewFileChanges' | 'historyTarget' | 'onHistoryTargetHandled'>
  & { paneId: string; host: HTMLDivElement }) {
  const controller = useChatController({ contextId: paneId, sessionSyncEnabled, sessionCache: workspace.sessionCache });
  const reviewFileChanges = useCallback((itemId: string, path?: string) => {
    onReviewFileChanges(paneId, itemId, path);
  }, [onReviewFileChanges, paneId]);
  const { registerController, selectPane, closePane } = workspace;
  const { registerAccountSwitchGuard } = workspace;
  const updateAccountSwitchGuard = useCallback((guard: (() => string | null) | null) => {
    registerAccountSwitchGuard(paneId, guard);
  }, [paneId, registerAccountSwitchGuard]);
  const [splitChoice, setSplitChoice] = useState<{ sourceThreadId: string | null } | null>(null);
  const initialSessionId = workspace.initialSessionIds[paneId];
  const initialSessionOpened = useRef(false);
  useEffect(() => {
    if (!initialSessionId || initialSessionOpened.current) return;
    initialSessionOpened.current = true;
    void controller.openSession(initialSessionId);
  }, [controller.openSession, initialSessionId]);
  const selected = workspace.activePaneId === paneId;
  const session = controller.state.sessions.find(item => item.id === controller.state.activeSessionId);
  const threadLabel = controller.state.activeSessionId ? session?.title.trim() || 'Conversation' : 'New chat';
  useLayoutEffect(() => registerController(paneId, controller), [controller, paneId, registerController]);
  useEffect(() => () => registerController(paneId, null), [paneId, registerController]);
  return createPortal(
    <section
      className={styles.pane}
      data-chat-pane={paneId}
      tabIndex={-1}
      data-active={selected ? 'true' : undefined}
      aria-label={threadLabel}
      onPointerDownCapture={() => selectPane(paneId)}
      onFocusCapture={() => selectPane(paneId)}
    >
      <LiquidGlassPanel as="header" className={styles.paneHeader}>
        <div className={styles.paneHeading}>
          {controller.agentBackThreadId && (
            <TooltipButton variant="ghost" size="icon" aria-label="Back to previous conversation" title="Back to previous conversation"
              disabled={controller.agentNavigationPending || controller.configurationPending || workspace.accountSwitchPending
                || workspace.relay.running || controller.state.phase === 'loading'}
              onClick={() => void controller.goBackFromAgent()}>
              <ArrowLeft aria-hidden="true" />
            </TooltipButton>
          )}
          <button className={styles.paneTitle} onClick={() => selectPane(paneId)} type="button">
            {!controller.agentBackThreadId && <ChatPaneIcon />}
            <span className={styles.paneTitleText}>
              <span>{threadLabel}</span>
              {controller.state.activeSessionId && <small className={styles.sessionId}>{controller.state.activeSessionId}</small>}
            </span>
          </button>
        </div>
        <div className={styles.actions}>
          <NeumorphicButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Split chat right"
            disabled={workspace.paneIds.length >= CHAT_PANE_LIMIT || workspace.splitPending}
            aria-haspopup="dialog"
            onClick={() => { workspace.dismissError(); setSplitChoice({ sourceThreadId: controller.state.activeSessionId }); }}
          >
            <Columns2 aria-hidden="true" />
          </NeumorphicButton>
          <TooltipButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close chat pane"
            title="Close pane"
            onClick={() => closePane(paneId)}
          >
            <X aria-hidden="true" />
          </TooltipButton>
        </div>
      </LiquidGlassPanel>
      <ChatView
        controller={controller}
        onOpenTemporaryChat={workspace.openTemporaryChat}
        onAccountSwitchGuard={updateAccountSwitchGuard}
        savedTurns={workspace.savedTurns}
        interactionsLocked={workspace.accountSwitchPending || (workspace.relay.running && workspace.relay.state !== null
          && chatRelayContextIds(workspace.relay.state).includes(paneId))}
        active={active && selected}
        visible={active}
        onNewSession={() => void controller.newSession()}
        onReviewFileChanges={reviewFileChanges}
        historyTarget={selected && controller.state.activeSessionId === historyTarget?.threadId ? historyTarget : null}
        onHistoryTargetHandled={onHistoryTargetHandled}
      />
      {splitChoice && <ChatSplitDialog workspace={workspace} paneId={paneId}
        sourceThreadId={splitChoice.sourceThreadId} target={host} onClose={() => setSplitChoice(null)} />}
    </section>, host, paneId,
  );
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const { workspace, rightSidebarOpen, onToggleRightSidebar } = props;
  const blurSourceRef = useRef<HTMLElement>(null);
  const paneVisible = useContext(WorkspacePaneVisibilityContext);
  const active = props.active && paneVisible;
  // Keep pane portals stable while recursive split branches are replaced.
  const hosts = useRef(new Map<string, HTMLDivElement>());
  for (const paneId of workspace.paneIds) {
    if (!hosts.current.has(paneId)) {
      const host = document.createElement('div');
      hosts.current.set(paneId, host);
    }
  }
  useEffect(() => {
    for (const id of hosts.current.keys()) {
      if (!workspace.paneIds.includes(id)) hosts.current.delete(id);
    }
  }, [workspace.paneIds]);
  return (
    <main ref={blurSourceRef} className={styles.root} hidden={!active} inert={!active} aria-label="Codex workspace">
      <TwoTierHeader
        className={viewStyles.header}
        style={draggableWindowRegionStyle}
        primary={<>
          <SidebarPanelTitle as="h2" title="CODEX"
            icon={<span className={viewStyles.openAIMark} aria-hidden="true" />} />
          <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
            <ChatRelayButton workspace={workspace} />
            <span className={styles.headerDivider} aria-hidden="true" />
            <WorkspaceLayoutControls />
            <SidebarToggle
              raised
              aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
              aria-pressed={rightSidebarOpen}
              className={`theme-toggle ${viewStyles.sidebarToggle}`}
              onClick={onToggleRightSidebar}
            >
              <PanelRight aria-hidden="true" />
            </SidebarToggle>
            {props.onCloseWorkspace && <NeumorphicButton raised size="icon"
              aria-label="Close Codex workspace" title="Close Codex workspace"
              onClick={props.onCloseWorkspace}><X aria-hidden="true" /></NeumorphicButton>}
          </div>
        </>}
      />
      <div className={styles.body}>
        <div className={styles.content}>
          <ChatRelayStatus workspace={workspace} />
          {workspace.error && <ChatErrorNotice onDismiss={workspace.dismissError} dismissLabel="Dismiss chat error">{workspace.error}</ChatErrorNotice>}
          <ChatPaneViewport layout={workspace.layout} activePaneId={workspace.activePaneId}
            onSelectPane={workspace.selectPane} onResizeSplit={workspace.resizeSplit}
            renderPane={(id) => <PaneMount paneId={id} host={hosts.current.get(id)!} />} />
        </div>
        <ChatRelayHistoryPanel blurSourceRef={blurSourceRef} relay={workspace.relay} savedTurns={workspace.savedTurns}
          onContinueSavedTurn={workspace.continueSavedTurn} continuationDisabledReason={workspace.savedTurnContinuationReason} />
      </div>
      {workspace.paneIds.map((paneId) => (
        <ChatPane
          {...props}
          active={active}
          key={paneId}
          paneId={paneId}
          host={hosts.current.get(paneId)!}
          sessionSyncEnabled={props.sessionSyncEnabled && workspace.activePaneId === paneId}
        />
      ))}
    </main>
  );
}
