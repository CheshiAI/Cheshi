import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { createChatMessageQueue } from './chatMessageQueueStore';
import { isViewedSessionResponding, normalizeChatEvent } from './model';
import type { ChatController } from './useChatController';

export function useChatMessageQueue(controller: ChatController, blocked: boolean) {
  const sendRef = useRef(controller.sendMessage);
  sendRef.current = controller.sendMessage;
  const storeRef = useRef<ReturnType<typeof createChatMessageQueue> | null>(null);
  if (!storeRef.current) storeRef.current = createChatMessageQueue((input, delivery) =>
    sendRef.current(input.draft, input.selectedSkill, input.attachments, delivery));
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    store.resume();
    const unsubscribe = cheshiDesktop?.onCodexChatEvent?.((value) => {
      const event = normalizeChatEvent(value);
      if (event?.type === 'turn-completed') store.complete(event.threadId, event.status);
      if (event?.type === 'sessions-deleted') store.deleteThreads(event.threadIds);
    }, controller.contextId);
    return () => { store.suspend(); unsubscribe?.(); };
  }, [store, controller.contextId]);
  useLayoutEffect(() => {
    store.setContext({ threadId: controller.state.activeSessionId, responding: isViewedSessionResponding(controller.state),
      blocked: blocked || controller.configurationPending || controller.state.phase === 'loading' || Boolean(controller.state.error) });
  });
  const threadId = controller.state.activeSessionId;
  return {
    ...store,
    entries: snapshot.entries.filter((entry) => entry.threadId === threadId),
    total: snapshot.entries.length,
    paused: threadId !== null && snapshot.pausedThreads.includes(threadId),
    toggleCurrent: () => { if (threadId) store.toggle(threadId); },
    cancelCurrent: () => { if (threadId) store.cancelThread(threadId); },
    pauseCurrent: () => { if (threadId) store.pause(threadId); },
  };
}
