import type { ChatState } from './model';

export function chatComposerAccountSwitchReason(options: {
  pending: boolean;
  draft: string;
  selectedSkill: unknown;
  attachmentCount: number;
  recoveryStatus?: 'restored' | 'available' | 'unknown';
}): string | null {
  if (options.pending) return 'Finish the composer operation before switching accounts.';
  if (options.draft || options.selectedSkill || options.attachmentCount > 0) {
    return 'Send or clear drafts and attachments in every chat pane before switching accounts.';
  }
  if (options.recoveryStatus === 'available' || options.recoveryStatus === 'unknown') {
    return 'Review the failed message and start a new chat before switching accounts.';
  }
  return null;
}

export function chatAccountSwitchReason(options: {
  pending: boolean;
  relayRunning: boolean;
  paneCount: number;
  controllers: readonly { state: ChatState; isOperationPending: () => boolean }[];
  composerReasons: readonly (string | null)[];
}): string | null {
  if (options.pending) return 'Wait for the current operation to finish before switching accounts.';
  if (options.relayRunning) return 'Finish the linked conversation before switching accounts.';
  if (options.controllers.length !== options.paneCount || options.composerReasons.length !== options.paneCount) {
    return 'Wait for the chat panes to be ready before switching accounts.';
  }
  if (options.controllers.some(({ state, isOperationPending }) => isOperationPending()
    || state.phase !== 'idle' || state.pendingNewResponse || state.responseThreadIds.length > 0
    || state.approvals.length > 0)) return 'Finish the active chat operation before switching accounts.';
  return options.composerReasons.find((reason) => reason !== null) ?? null;
}
