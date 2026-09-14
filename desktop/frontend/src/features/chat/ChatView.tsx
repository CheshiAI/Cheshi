import { useLayoutEffect, useMemo, useRef } from 'react';
import { ChatComposer } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';
import styles from './ChatView.module.css';
import type { ChatController } from './useChatController';
import { useChatViewController } from './useChatViewController';
import type { SavedChatTurnsController } from './useSavedChatTurns';
import { chatComposerAccountSwitchReason } from './chatAccountSwitch';
import type { ChatHistorySearchNavigation } from './chatHistorySearchNavigation';
import { ChatAsyncQuestionContext } from './ChatAsyncQuestions';
import { completedAsyncQuestionAnswers } from './chatAsyncQuestionAnswers';

interface ChatViewProps extends ChatHistorySearchNavigation {
  controller: ChatController;
  onNewSession: () => void;
  onReviewFileChanges: (itemId: string, path?: string) => void;
  active: boolean;
  interactionsLocked?: boolean;
  savedTurns?: SavedChatTurnsController;
  onAccountSwitchGuard?: (guard: (() => string | null) | null) => void;
}

export function ChatView({
  controller,
  onNewSession,
  onReviewFileChanges,
  active,
  interactionsLocked = false,
  savedTurns,
  onAccountSwitchGuard,
  historyTarget,
  onHistoryTargetHandled,
}: ChatViewProps) {
  const viewController = useChatViewController({ controller, onNewSession, active, interactionsLocked });
  const questionAnswers = useMemo(() => completedAsyncQuestionAnswers(controller.state.items), [controller.state.items]);
  const latest = useRef(viewController);
  latest.current = viewController;
  const hasDraft = Boolean(viewController.draft || viewController.selectedSkill || viewController.attachments.length
    || controller.queuedMessageCount
    || (viewController.sendRecovery && viewController.sendRecovery.status !== 'restored'));
  const busy = viewController.sendPending || viewController.commandLoading || viewController.configurationLoading
    || viewController.attachmentPickerOpen || viewController.attachmentTransfer.loading;
  useLayoutEffect(() => {
    onAccountSwitchGuard?.(() => {
      const current = latest.current;
      if (controller.queuedMessageCount > 0) return 'Send or remove queued messages before switching accounts.';
      return chatComposerAccountSwitchReason({
        pending: current.sendPending || current.commandLoading || current.configurationLoading
          || current.attachmentPickerOpen || current.attachmentTransfer.isTransferring(),
        draft: current.draft, selectedSkill: current.selectedSkill, attachmentCount: current.attachments.length,
        recoveryStatus: current.sendRecovery?.status,
      });
    });
    return () => onAccountSwitchGuard?.(null);
  }, [onAccountSwitchGuard, hasDraft, busy, controller.queuedMessageCount]);

  return (
    <section className={styles.root} ref={viewController.rootRef}
      onDragOver={viewController.attachmentTransfer.onDragOver} onDrop={viewController.attachmentTransfer.onDrop}>
      <ChatAsyncQuestionContext.Provider value={{
        disabled: !active || interactionsLocked || busy || viewController.loading || controller.configurationPending,
        send: controller.sendMessage,
        answers: questionAnswers,
      }}>
        <ChatTimeline controller={viewController} onReviewFileChanges={onReviewFileChanges} savedTurns={savedTurns}
          historyTarget={historyTarget} onHistoryTargetHandled={onHistoryTargetHandled} />
      </ChatAsyncQuestionContext.Provider>
      <ChatComposer chatController={controller} controller={viewController} userInputContextId={controller.contextId} />
    </section>
  );
}
