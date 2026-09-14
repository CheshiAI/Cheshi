import { ArrowLeft, Columns2, PanelRight, Plus, Rows2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chatRelayContextIds } from '../../../../shared/chat-relay';
import {
  LiquidGlassPanel, NeumorphicButton, TwoTierHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { SplitPaneLayout } from '../../shared/ui/SplitPaneLayout';
import { ChatView } from './ChatView';
import { ChatErrorNotice } from './ChatErrorNotice';
import { ChatPaneIcon } from './ChatPaneIcon';
import { ChatRelayButton, ChatRelayStatus } from './ChatRelayControls';
import { ChatRelayHistoryPanel } from './ChatRelayHistoryPanel';
import { ChatSplitDialog } from './ChatSplitDialog';
import { useChatController } from './useChatController';
import { useChatAgentNavigation } from './useChatAgentNavigation';
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
  onReviewFileChanges: (paneId: string, itemId: string, path?: string) => void;
}

function PaneMount({ host }: { host: HTMLDivElement }) {
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
  return <div className={styles.mount} ref={mountRef} />;
}

function ChatPane({
  paneId, host, workspace, active, sessionSyncEnabled, onReviewFileChanges, historyTarget, onHistoryTargetHandled,
}: Pick<ChatWorkspaceProps, 'workspace' | 'active' | 'sessionSyncEnabled' | 'onReviewFileChanges' | 'historyTarget' | 'onHistoryTargetHandled'>
  & { paneId: string; host: HTMLDivElement }) {
  const interactionsLocked = workspace.accountSwitchPending || (workspace.relay.running && workspace.relay.state !== null
    && chatRelayContextIds(workspace.relay.state).includes(paneId));
  const controller = useChatController({ contextId: paneId, sessionSyncEnabled, sessionCache: workspace.sessionCache,
    queuePaused: interactionsLocked });
  const agentNavigation = useChatAgentNavigation({
    activeSessionId: controller.state.activeSessionId,
    isKnownMainSession: controller.state.sessions.some(session => session.id === controller.state.activeSessionId),
    listAgents: controller.listAgents,
    openAgent: controller.openAgent,
    isOperationPending: controller.isOperationPending,
  });
  const reviewFileChanges = useCallback((itemId: string, path?: string) => {
    onReviewFileChanges(paneId, itemId, path);
  }, [onReviewFileChanges, paneId]);
  const { registerController, selectPane, closePane } = workspace;
  const { registerAccountSwitchGuard } = workspace;
  const updateAccountSwitchGuard = useCallback((guard: (() => string | null) | null) => {
    registerAccountSwitchGuard(paneId, guard);
  }, [paneId, registerAccountSwitchGuard]);
  const [splitChoice, setSplitChoice] = useState<{ direction: 'right' | 'down'; sourceThreadId: string | null } | null>(null);
  const initialSessionId = workspace.initialSessionIds[paneId];
  const initialSessionOpened = useRef(false);
  useEffect(() => {
    if (!initialSessionId || initialSessionOpened.current) return;
    initialSessionOpened.current = true;
    void controller.openSession(initialSessionId);
  }, [controller.openSession, initialSessionId]);
  const selected = workspace.activePaneId === paneId;
  const threadLabel = controller.state.activeSessionId ?? 'Pending thread';
  useLayoutEffect(() => registerController(paneId, controller), [controller, paneId, registerController]);
  useEffect(() => () => registerController(paneId, null), [paneId, registerController]);
  return createPortal(
    <section
      className={styles.pane}
      data-active={selected ? 'true' : undefined}
      aria-label={threadLabel}
      onPointerDownCapture={() => selectPane(paneId)}
      onFocusCapture={() => selectPane(paneId)}
    >
      <LiquidGlassPanel as="header" className={styles.paneHeader} data-liquid-glass-backdrop={selected ? 'true' : undefined}>
        <div className={styles.paneHeading}>
          {agentNavigation.mainThreadId && <NeumorphicButton
            raised
            size="icon"
            aria-label="Back to main agent"
            title="Back to main agent"
            aria-busy={agentNavigation.returning}
            disabled={agentNavigation.returning || interactionsLocked || controller.configurationPending || controller.state.phase === 'loading'}
            onClick={() => void agentNavigation.returnToMain()}
          >
            <ArrowLeft aria-hidden="true" />
          </NeumorphicButton>}
          <button className={styles.paneTitle} onClick={() => selectPane(paneId)} title={threadLabel} type="button">
            {!agentNavigation.mainThreadId && <ChatPaneIcon />}
            <span>{threadLabel}</span>
          </button>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            aria-label="Split chat right"
            title="Split chat right"
            disabled={workspace.paneIds.length >= 32 || workspace.splitPending}
            aria-haspopup="dialog"
            onClick={() => { workspace.dismissError(); setSplitChoice({ direction: 'right', sourceThreadId: controller.state.activeSessionId }); }}
          >
            <Columns2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.action}
            aria-label="Split chat down"
            title="Split chat down"
            disabled={workspace.paneIds.length >= 32 || workspace.splitPending}
            aria-haspopup="dialog"
            onClick={() => { workspace.dismissError(); setSplitChoice({ direction: 'down', sourceThreadId: controller.state.activeSessionId }); }}
          >
            <Rows2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.action}
            aria-label="Close chat pane"
            title="Close pane"
            onClick={() => closePane(paneId)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </LiquidGlassPanel>
      {agentNavigation.error && <ChatErrorNotice className={styles.navigationError} onDismiss={agentNavigation.dismissError}>
        {agentNavigation.error}
      </ChatErrorNotice>}
      <ChatView
        controller={controller}
        onAccountSwitchGuard={updateAccountSwitchGuard}
        savedTurns={workspace.savedTurns}
        interactionsLocked={interactionsLocked}
        active={active && selected}
        onNewSession={() => void controller.newSession()}
        onReviewFileChanges={reviewFileChanges}
        historyTarget={selected && controller.state.activeSessionId === historyTarget?.threadId ? historyTarget : null}
        onHistoryTargetHandled={onHistoryTargetHandled}
      />
      {splitChoice && <ChatSplitDialog workspace={workspace} paneId={paneId} direction={splitChoice.direction}
        sourceThreadId={splitChoice.sourceThreadId} onClose={() => setSplitChoice(null)} />}
    </section>, host, paneId,
  );
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const { workspace, active, rightSidebarOpen, onToggleRightSidebar } = props;
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
    <main className={styles.root} hidden={!active} inert={!active} aria-label="Codex workspace">
      <TwoTierHeader
        className={viewStyles.header}
        style={draggableWindowRegionStyle}
        primary={<>
          <div className={viewStyles.title}>
            <NeumorphicButton raised aria-hidden="true" className={`theme-toggle ${viewStyles.titleMark}`} disabled><span className={viewStyles.openAIMark} /></NeumorphicButton>
            <h1>Codex</h1>
          </div>
          <div className={styles.headerActions} style={nonDraggableWindowRegionStyle}>
            <ChatRelayButton workspace={workspace} className={`theme-toggle ${viewStyles.sidebarToggle}`} />
            <NeumorphicButton
              raised
              className={`theme-toggle ${viewStyles.sidebarToggle}`}
              aria-label="New chat in active pane"
              title="New chat"
              disabled={!workspace.activeController || workspace.activeController.state.phase === 'loading'
                || (workspace.relay.running && workspace.relay.state !== null
                  && chatRelayContextIds(workspace.relay.state).includes(workspace.activePaneId))}
              onClick={() => void workspace.activeController?.newSession()}
            >
              <Plus aria-hidden="true" />
            </NeumorphicButton>
            <NeumorphicButton
              raised
              aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
              aria-pressed={rightSidebarOpen}
              className={`theme-toggle ${viewStyles.sidebarToggle}`}
              onClick={onToggleRightSidebar}
            >
              <PanelRight aria-hidden="true" />
            </NeumorphicButton>
          </div>
        </>}
      />
      <div className={styles.body}>
        <div className={styles.content}>
          <ChatRelayStatus workspace={workspace} />
          {workspace.error && <ChatErrorNotice onDismiss={workspace.dismissError} dismissLabel="Dismiss chat error">{workspace.error}</ChatErrorNotice>}
          <div className={styles.split}>
            <SplitPaneLayout layout={workspace.layout} renderPane={(id) => <PaneMount host={hosts.current.get(id)!} />} onResizeSplit={workspace.resizeSplit} resizeLabel="Resize chat panes" />
          </div>
        </div>
        <ChatRelayHistoryPanel relay={workspace.relay} savedTurns={workspace.savedTurns}
          onContinueSavedTurn={workspace.continueSavedTurn} continuationDisabledReason={workspace.savedTurnContinuationReason} />
      </div>
      {workspace.paneIds.map((paneId) => (
        <ChatPane
          {...props}
          key={paneId}
          paneId={paneId}
          host={hosts.current.get(paneId)!}
          sessionSyncEnabled={props.sessionSyncEnabled && workspace.activePaneId === paneId}
        />
      ))}
    </main>
  );
}
