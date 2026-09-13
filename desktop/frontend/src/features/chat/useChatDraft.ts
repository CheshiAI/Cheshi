import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createChatDraftRecovery, type ChatDraftSnapshot, type ChatSendResult } from './chatDraftRecovery';

export function useChatDraft(sessionRevision: number, send: (input: ChatDraftSnapshot) => Promise<ChatSendResult>) {
  const sendRef = useRef(send);
  sendRef.current = send;
  const storeRef = useRef<ReturnType<typeof createChatDraftRecovery> | null>(null);
  if (!storeRef.current) storeRef.current = createChatDraftRecovery((input) => sendRef.current(input));
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useLayoutEffect(() => { store.reset(); return () => store.reset(); }, [sessionRevision, store]);
  return {
    ...state,
    setDraft: (value: string) => store.edit('draft', value),
    setSelectedSkill: (value: ChatDraftSnapshot['selectedSkill']) => store.edit('selectedSkill', value),
    setAttachments: (value: ChatDraftSnapshot['attachments'] | ((current: ChatDraftSnapshot['attachments']) => ChatDraftSnapshot['attachments'])) => store.edit('attachments', value),
    submitDraft: store.submit,
    restoreFailedMessage: store.restore,
    canRestoreFailedMessage: state.recovery?.status === 'available' && !state.pending && !state.draft && !state.selectedSkill && state.attachments.length === 0,
  };
}
