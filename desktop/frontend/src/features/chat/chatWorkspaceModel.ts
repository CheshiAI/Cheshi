import {
  insertSplitPane, removeSplitPane, resizeSplitPane, splitPaneIds,
  type SplitLayoutNode, type SplitPaneDirection,
} from '../../shared/ui/splitPaneModel';
import type { ChatState } from './model';

export function chatForkUnavailableReason(state: Pick<ChatState, 'activeSessionId' | 'phase' | 'pendingNewResponse' | 'responseThreadIds' | 'approvals'> | undefined, locked: boolean): string | null {
  if (!state?.activeSessionId) return 'Send a message first to create a session.';
  return chatHistoryForkUnavailableReason(state, locked, false);
}

export function chatHistoryForkUnavailableReason(state: Pick<ChatState, 'phase' | 'pendingNewResponse' | 'responseThreadIds' | 'approvals'> | undefined, locked: boolean, sourceResponding: boolean): string | null {
  if (!state) return 'The destination pane is unavailable.';
  if (locked) return 'Wait for the conversation relay to finish before forking.';
  if (sourceResponding) return 'Wait for the selected conversation to finish responding before forking.';
  if (state.phase !== 'idle' || state.pendingNewResponse || state.responseThreadIds.length > 0 || state.approvals.length > 0) {
    return 'Wait for this pane to finish its current operation before forking.';
  }
  return null;
}

export interface ChatWorkspaceState {
  layout: SplitLayoutNode;
  activePaneId: string;
}

export function createChatWorkspace(paneId: string): ChatWorkspaceState {
  return { layout: { type: 'pane', paneId }, activePaneId: paneId };
}

export function splitChatPane(
  state: ChatWorkspaceState, targetId: string, paneId: string,
  direction: SplitPaneDirection, splitId: string,
): ChatWorkspaceState {
  if (!splitPaneIds(state.layout).includes(targetId)) return state;
  return {
    layout: insertSplitPane(state.layout, targetId, paneId, direction, splitId),
    activePaneId: paneId,
  };
}

export function closeChatPane(
  state: ChatWorkspaceState, paneId: string, replacementId: string,
): ChatWorkspaceState {
  const ids = splitPaneIds(state.layout);
  const index = ids.indexOf(paneId);
  if (index < 0) return state;
  const layout = removeSplitPane(state.layout, paneId);
  if (!layout) return createChatWorkspace(replacementId);
  const remaining = splitPaneIds(layout);
  return {
    layout,
    activePaneId: state.activePaneId === paneId
      ? remaining[Math.min(index, remaining.length - 1)]!
      : state.activePaneId,
  };
}

export function resizeChatPane(state: ChatWorkspaceState, splitId: string, ratio: number): ChatWorkspaceState {
  const layout = resizeSplitPane(state.layout, splitId, ratio);
  return layout === state.layout ? state : { ...state, layout };
}
