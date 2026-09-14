import type { ChatDraftSnapshot, ChatSendResult } from './chatDraftRecovery';

export interface ChatQueuedMessage {
  id: string;
  threadId: string;
  input: ChatDraftSnapshot;
  status: 'queued' | 'sending' | 'paused' | 'unknown';
  message?: string;
}

/** A completion releases one instruction; each subsequent instruction waits for its own turn. */
export function createChatMessageQueue() {
  let items: readonly ChatQueuedMessage[] = [];
  let sequence = 0;
  const ready = new Set<string>();
  const listeners = new Set<() => void>();
  const update = (next: readonly ChatQueuedMessage[]) => {
    items = next;
    listeners.forEach(listener => listener());
  };
  const pause = (threadId: string, message: string) => {
    ready.delete(threadId);
    update(items.map(item => item.threadId === threadId && item.status === 'queued'
      ? { ...item, status: 'paused', message } : item));
  };
  return {
    getSnapshot: () => items,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enqueue(threadId: string, input: ChatDraftSnapshot): boolean {
      if (!threadId || !input.draft.trim()) return false;
      update([...items, { id: `queued-${++sequence}`, threadId,
        input: { ...input, selectedSkill: input.selectedSkill && { ...input.selectedSkill },
          attachments: input.attachments.map(attachment => ({ ...attachment })) }, status: 'queued' }]);
      return true;
    },
    remove(id: string) { update(items.filter(item => item.id !== id || item.status === 'sending')); },
    retry(id: string) {
      const target = items.find(item => item.id === id && item.status === 'paused');
      if (!target) return;
      ready.add(target.threadId);
      update(items.map(item => item.threadId === target.threadId && item.status === 'paused'
        ? { ...item, status: 'queued', message: undefined } : item));
    },
    pause,
    forget(threadIds: readonly string[]) {
      threadIds.forEach(id => ready.delete(id));
      update(items.filter(item => !threadIds.includes(item.threadId)));
    },
    observe(event: { type: string; threadId?: string | null; status?: string; message?: string | null }) {
      if (event.type === 'error' && !event.threadId) {
        for (const threadId of new Set(items.map(item => item.threadId))) pause(threadId, event.message ?? 'The response failed.');
        return;
      }
      if (!event.threadId || !items.some(item => item.threadId === event.threadId)) return;
      if (event.type === 'turn-started') ready.delete(event.threadId);
      if (event.type === 'turn-completed') {
        if (event.status === 'completed') { ready.add(event.threadId); update([...items]); }
        else pause(event.threadId, event.message ?? 'The response stopped. Resume the queue when ready.');
      }
      if (event.type === 'error') pause(event.threadId, event.message ?? 'The response failed.');
    },
    async drain(threadId: string, send: (input: ChatDraftSnapshot, threadId: string) => Promise<ChatSendResult>) {
      const next = items.find(item => item.threadId === threadId);
      if (!ready.has(threadId) || !next || next.status !== 'queued') return;
      ready.delete(threadId);
      update(items.map(item => item === next ? { ...item, status: 'sending' } : item));
      let result: ChatSendResult;
      try { result = await send(next.input, threadId); }
      catch (error) { result = { status: 'unknown', message: error instanceof Error ? error.message : String(error) }; }
      if (result.status === 'accepted') {
        update(items.filter(item => item.id !== next.id));
      } else {
        pause(threadId, 'Review the unsent message before resuming the queue.');
        update(items.map(item => item.id === next.id
          ? { ...item, status: result.status === 'unknown' ? 'unknown' : 'paused',
            message: result.message ?? 'The queued message was not sent.' } : item));
      }
    },
  };
}
