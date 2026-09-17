import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { FallbackQuestionRequest } from './chatQuestionChoices';
import { isViewedSessionResponding } from './model';
import { ChatUserInputPrompt } from './ChatUserInputPrompt';
import { createFallbackQuestionStore } from './chatFallbackQuestionStore';
import type { ChatController } from './useChatController';
import type { ChatViewController } from './useChatViewController';
import { cheshiDesktop } from '../../cheshiDesktop';
import { ChatErrorNotice } from './ChatErrorNotice';
import { NeumorphicButton } from '../../shared/ui';
import type { ChatQuestionDismissalsApi } from '../../../../shared/chat-question-dismissals';

const desktopPersistence: ChatQuestionDismissalsApi = {
  async list(threadId) {
    if (!cheshiDesktop?.chatQuestionDismissals) throw new Error('Restart Cheshi to restore dismissed questions.');
    return cheshiDesktop.chatQuestionDismissals.list(threadId);
  },
  async save(threadId, record) {
    if (!cheshiDesktop?.chatQuestionDismissals) throw new Error('Restart Cheshi to save dismissed questions.');
    return cheshiDesktop.chatQuestionDismissals.save(threadId, record);
  },
};

export function createMessageQuestionStore(currentController: () => ChatController, persistence = desktopPersistence) {
  return createFallbackQuestionStore((text, threadId, request) => {
    const controller = currentController();
    const mode = request.delivery === 'async' && isViewedSessionResponding(controller.state) ? 'steer' : 'next-turn';
    return controller.sendMessage(text, null, [], { threadId, mode });
  }, persistence);
}

export function ChatFallbackQuestion({ candidate, controller, chatController, active, inline = false, persistence = desktopPersistence, retainedStore }: {
  candidate: FallbackQuestionRequest | null; controller: ChatViewController; chatController: ChatController; active: boolean; inline?: boolean;
  persistence?: ChatQuestionDismissalsApi;
  retainedStore?: ReturnType<typeof createMessageQuestionStore>;
}) {
  const latest = useRef(chatController);
  latest.current = chatController;
  const storeRef = useRef<ReturnType<typeof createFallbackQuestionStore> | null>(null);
  if (!retainedStore && !storeRef.current) storeRef.current = createMessageQuestionStore(() => latest.current, persistence);
  const store = retainedStore ?? storeRef.current!;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const threadId = controller.state.activeSessionId;
  const asyncQuestion = (state.request ?? candidate)?.delivery === 'async';
  const blocked = !active || controller.loading || controller.queueBlocked
    || (!asyncQuestion && (controller.streaming || controller.configurationControlsDisabled))
    || controller.configurationMenuOpen || controller.configurationLoading || controller.attachmentPickerOpen
    || controller.attachmentTransfer.loading || chatController.isOperationPending();
  useLayoutEffect(() => { store.setActive(true); return () => { if (!retainedStore) store.setActive(false); }; }, [store, retainedStore]);
  useLayoutEffect(() => { store.sync(threadId,
    controller.loading || (controller.streaming && candidate?.delivery !== 'async') ? null : candidate, blocked); });
  if (state.restoreError) return <ChatErrorNotice action={<NeumorphicButton raised size="standard" onClick={() => void store.retryRestore()}>Retry</NeumorphicButton>}>
    {state.restoreError}
  </ChatErrorNotice>;
  if (inline && candidate?.threadId === threadId && state.resolution
    && (state.resolution.questionId === candidate.id || state.resolution.questionId === candidate.legacyQuestionId)) {
    return <ChatUserInputPrompt key={candidate.id} request={candidate} respond={store.respond}
      pending={false} error={null} resolution={state.resolution} />;
  }
  if (!state.request || state.request.threadId !== threadId) return null;
  return <ChatUserInputPrompt key={state.request.id} request={state.request} respond={store.respond}
    pending={state.pending} error={state.error} answerDisabled={blocked || state.uncertain} />;
}
