import { isViewedSessionResponding, type ChatState } from './model';

export function chatSessionDeletionReason(sessionId: string, ready: boolean, pending: boolean, relayRunning: boolean,
  controllers: readonly { state: ChatState; isOperationPending: () => boolean }[]): string | null {
  if (!ready) return 'Wait for the chat pane to be ready.';
  if (pending) return 'Wait for the current operation to finish.';
  if (relayRunning) return 'Wait for the linked conversation to finish.';
  if (controllers.some((controller) => controller.isOperationPending() || controller.state.phase === 'loading')) {
    return 'Wait for the current operation to finish.';
  }
  if (controllers.some((controller) => isViewedSessionResponding(controller.state) || controller.state.pendingNewResponse
    || controller.state.responseThreadIds.length > 0
    || controller.state.sessions.some((session) => session.id === sessionId && session.status === 'active'))) {
    return 'Stop the active response before deleting a conversation.';
  }
  return null;
}
