import type { ChatDraftSnapshot, ChatSendResult } from './chatDraftRecovery';

export interface QueuedChatMessage {
  id: string;
  threadId: string;
  input: ChatDraftSnapshot;
  status: 'queued' | 'sending' | 'failed' | 'unknown';
  error?: string;
}
export interface ChatQueueDelivery { threadId: string; mode: 'next-turn' | 'steer' }
interface QueueContext { threadId: string | null; responding: boolean; blocked: boolean }
interface QueueState { entries: QueuedChatMessage[]; pausedThreads: string[] }

/** Unsent messages are scoped to a conversation and retained until accepted or explicitly cancelled. */
export function createChatMessageQueue(send: (input: ChatDraftSnapshot, delivery: ChatQueueDelivery) => Promise<ChatSendResult>) {
  let state: QueueState = { entries: [], pausedThreads: [] };
  let context: QueueContext = { threadId: null, responding: false, blocked: true };
  let suspended = false;
  let busy = false;
  const awaitingTurn = new Set<string>();
  const completions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<QueueState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const paused = (threadId: string) => state.pausedThreads.includes(threadId);
  const pause = (threadId: string) => {
    if (!paused(threadId)) publish({ pausedThreads: [...state.pausedThreads, threadId] });
  };
  const remove = (id: string) => publish({ entries: state.entries.filter((entry) => entry.id !== id) });
  const update = (id: string, patch: Partial<QueuedChatMessage>) => publish({
    entries: state.entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
  });
  const editable = (id: string) => state.entries.find((entry) => entry.id === id && entry.status !== 'sending');
  const deliver = async (entry: QueuedChatMessage, mode: ChatQueueDelivery['mode']) => {
    if (suspended || busy || context.blocked || entry.threadId !== context.threadId) return false;
    if ((mode === 'next-turn') === context.responding) return false;
    if (entry.status === 'unknown') return false;
    busy = true;
    const completion = completions.get(entry.threadId) ?? 0;
    update(entry.id, { status: 'sending', error: undefined });
    let result: ChatSendResult;
    try { result = await send(entry.input, { threadId: entry.threadId, mode }); }
    catch (error) { result = { status: 'unknown', message: error instanceof Error ? error.message : String(error) }; }
    busy = false;
    if (!state.entries.some((current) => current.id === entry.id)) return result.status === 'accepted';
    if (result.status === 'accepted') {
      // A very short turn can finish before the send acknowledgement arrives.
      if ((completions.get(entry.threadId) ?? 0) === completion) awaitingTurn.add(entry.threadId);
      remove(entry.id);
      return true;
    }
    pause(entry.threadId);
    update(entry.id, { status: result.status === 'unknown' ? 'unknown' : 'failed',
      error: result.message ?? 'The message was not sent. Enable the queue to retry.' });
    return false;
  };
  const pump = () => {
    const { threadId, responding, blocked } = context;
    if (suspended || busy || !threadId || responding || blocked || paused(threadId) || awaitingTurn.has(threadId)) return;
    const first = state.entries.find((entry) => entry.threadId === threadId);
    if (first?.status === 'queued') void deliver(first, 'next-turn');
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setContext(value: QueueContext) { context = value; pump(); },
    suspend() { suspended = true; },
    resume() { suspended = false; },
    enqueue(input: ChatDraftSnapshot) {
      if (suspended || !context.threadId || !context.responding || context.blocked || !input.draft.trim()) return false;
      publish({ entries: [...state.entries, { id: crypto.randomUUID(), threadId: context.threadId,
        input: { ...input, attachments: [...input.attachments] }, status: 'queued' }] });
      return true;
    },
    pause,
    cancelThread(threadId: string) {
      awaitingTurn.delete(threadId);
      publish({ entries: state.entries.filter((entry) => entry.threadId !== threadId),
        pausedThreads: paused(threadId) ? state.pausedThreads : [...state.pausedThreads, threadId] });
    },
    toggle(threadId: string) {
      if (!paused(threadId)) { pause(threadId); return; }
      publish({ pausedThreads: state.pausedThreads.filter((id) => id !== threadId),
        entries: state.entries.map((entry) => entry.threadId === threadId && entry.status === 'failed'
          ? { ...entry, status: 'queued', error: undefined } : entry) });
      pump();
    },
    complete(threadId: string, status: string) {
      completions.set(threadId, (completions.get(threadId) ?? 0) + 1);
      awaitingTurn.delete(threadId);
      if (status !== 'completed') pause(threadId);
      else publish({});
      // Wait for the controller to observe completion and supply its idle state.
    },
    deleteThreads(ids: string[]) {
      ids.forEach((id) => { awaitingTurn.delete(id); completions.delete(id); });
      publish({ entries: state.entries.filter((entry) => !ids.includes(entry.threadId)),
        pausedThreads: state.pausedThreads.filter((id) => !ids.includes(id)) });
    },
    remove(id: string) { if (editable(id)) remove(id); },
    take(id: string, receive: (input: ChatDraftSnapshot) => boolean) {
      const entry = editable(id);
      if (!entry || context.blocked || entry.threadId !== context.threadId || !receive(entry.input)) return false;
      remove(id);
      return true;
    },
    steer(id: string) {
      const entry = editable(id);
      return entry ? deliver(entry, 'steer') : Promise.resolve(false);
    },
  };
}
