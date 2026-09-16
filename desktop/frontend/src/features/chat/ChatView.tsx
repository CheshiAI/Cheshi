import { useLayoutEffect, useRef } from 'react';
import { ChatComposer } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';
import styles from './ChatView.module.css';
import type { ChatController } from './useChatController';
import { useChatViewController } from './useChatViewController';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import { chatComposerAccountSwitchReason } from './chatAccountSwitch';
import type { ChatHistorySearchNavigation } from './chatHistorySearchNavigation';
import type { ChatDraftSnapshot } from './chatDraftRecovery';
import { useChatDraftAttachmentTarget } from './chatDraftAttachments';
import { ChatQuestionProvider } from './ChatInlineQuestion';
import { AgentActivityProvider } from './AgentActivity';

interface ChatViewProps extends ChatHistorySearchNavigation {
  controller: ChatController;
  onNewSession: () => void;
  initialDraft?: ChatDraftSnapshot;
  onOpenSideChat?: (input: ChatDraftSnapshot) => boolean;
  onReviewFileChanges: (itemId: string, path?: string) => void;
  active: boolean;
  interactionsLocked?: boolean;
  savedTurns?: SavedChatTurnsController;
  onAccountSwitchGuard?: (guard: (() => string | null) | null) => void;
}

export function ChatView({
  controller,
  onNewSession,
  initialDraft,
  onOpenSideChat,
  onReviewFileChanges,
  active,
  interactionsLocked = false,
  savedTurns,
  onAccountSwitchGuard,
  historyTarget,
  onHistoryTargetHandled,
}: ChatViewProps) {
  const viewController = useChatViewController({ controller, onNewSession, initialDraft, onOpenSideChat, active, interactionsLocked });
  useChatDraftAttachmentTarget(controller.contextId, viewController.attachmentTransfer.attachFilesToDraft);
  const latest = useRef(viewController);
  latest.current = viewController;
  const hasDraft = Boolean(viewController.messageQueue.total || viewController.draft || viewController.selectedSkill || viewController.attachments.length
    || (viewController.sendRecovery && viewController.sendRecovery.status !== 'restored'));
  const busy = viewController.sendPending || viewController.commandLoading || viewController.configurationLoading
    || viewController.attachmentPickerOpen || viewController.attachmentTransfer.loading;
  useLayoutEffect(() => {
    onAccountSwitchGuard?.(() => {
      const current = latest.current;
      if (current.messageQueue.total) return 'Send or remove queued messages before switching accounts.';
      return chatComposerAccountSwitchReason({
        pending: current.sendPending || current.commandLoading || current.configurationLoading
          || current.attachmentPickerOpen || current.attachmentTransfer.isTransferring(),
        draft: current.draft, selectedSkill: current.selectedSkill, attachmentCount: current.attachments.length,
        recoveryStatus: current.sendRecovery?.status,
      });
    });
    return () => onAccountSwitchGuard?.(null);
  }, [onAccountSwitchGuard, hasDraft, busy]);

  return (
    <section className={styles.root} ref={viewController.rootRef} onKeyDown={viewController.handleEscape}
      onDragOver={viewController.attachmentTransfer.onDragOver} onDrop={viewController.attachmentTransfer.onDrop}>
      <ChatQuestionProvider controller={viewController} chatController={controller} active={active}>
        <AgentActivityProvider key={`${controller.contextId}:${controller.state.activeSessionId}`} contextId={controller.contextId}
          threadId={controller.state.activeSessionId} active={active} streaming={viewController.streaming}>
        <ChatTimeline controller={viewController} onReviewFileChanges={onReviewFileChanges} savedTurns={savedTurns}
          historyTarget={historyTarget} onHistoryTargetHandled={onHistoryTargetHandled} />
        </AgentActivityProvider>
      </ChatQuestionProvider>
      <ChatComposer chatController={controller} controller={viewController} userInputContextId={controller.contextId} active={active} />
    </section>
  );
}
