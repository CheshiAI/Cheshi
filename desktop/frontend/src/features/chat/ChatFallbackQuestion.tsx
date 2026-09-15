import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { ChatUserInputRequest } from '../../../../shared/chat-user-input';
import { ChatUserInputPrompt } from './ChatUserInputPrompt';
import { createFallbackQuestionStore } from './chatFallbackQuestionStore';
import type { ChatController } from './useChatController';
import type { ChatViewController } from './useChatViewController';
import { cheshiDesktop } from '../../cheshiDesktop';
import { ChatErrorNotice } from './ChatErrorNotice';
import { NeumorphicButton } from '../../shared/ui';
import type { ChatQuestionDismissalsApi } from '../../../../shared/chat-question-dismissals';

const persistence: ChatQuestionDismissalsApi = {
  async list(threadId) {
    if (!cheshiDesktop?.chatQuestionDismissals) throw new Error('Restart Cheshi to restore dismissed questions.');
    return cheshiDesktop.chatQuestionDismissals.list(threadId);
  },
  async save(threadId, record) {
    if (!cheshiDesktop?.chatQuestionDismissals) throw new Error('Restart Cheshi to save dismissed questions.');
    return cheshiDesktop.chatQuestionDismissals.save(threadId, record);
  },
};

export function ChatFallbackQuestion({ candidate, controller, chatController, active }: {
  candidate: ChatUserInputRequest | null; controller: ChatViewController; chatController: ChatController; active: boolean;
}) {
  const latest = useRef(chatController);
  latest.current = chatController;
  const storeRef = useRef<ReturnType<typeof createFallbackQuestionStore> | null>(null);
  if (!storeRef.current) storeRef.current = createFallbackQuestionStore((text, threadId) =>
    latest.current.sendMessage(text, null, [], { threadId, mode: 'next-turn' }), persistence);
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const threadId = controller.state.activeSessionId;
  const blocked = !active || controller.loading || controller.streaming || controller.configurationControlsDisabled
    || controller.configurationMenuOpen || controller.configurationLoading || controller.attachmentPickerOpen
    || controller.attachmentTransfer.loading || chatController.isOperationPending();
  useLayoutEffect(() => { store.setActive(true); return () => store.setActive(false); }, [store]);
  useLayoutEffect(() => { store.sync(threadId, controller.loading || controller.streaming ? null : candidate, blocked); });
  if (state.restoreError) return <ChatErrorNotice action={<NeumorphicButton raised size="standard" onClick={() => void store.retryRestore()}>Retry</NeumorphicButton>}>
    {state.restoreError}
  </ChatErrorNotice>;
  if (!state.request || state.request.threadId !== threadId) return null;
  return <ChatUserInputPrompt key={state.request.id} request={state.request} respond={store.respond}
    pending={state.pending} error={state.error} answerDisabled={blocked || state.uncertain} />;
}
