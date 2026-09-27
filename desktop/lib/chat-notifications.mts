import type { ChatNotification } from './imessage-notifications.mts';
import { inputRecord } from '../shared/chat-user-input.ts';

interface Conversation {
  busy: boolean; completed: boolean; failed: boolean; queue: number;
  turn: string | null; seenTurns: Set<string>;
  waiting: Set<string>; noticed: Set<string>; timer?: ReturnType<typeof setTimeout>;
}
/** Observes live events only. Loading history never generates alerts. */
export function createChatNotifications(options: { workspace: string; notify(event: ChatNotification, context: string, thread: string): void; delayMs?: number }) {
  const contexts = new Map<string, Map<string, Conversation>>();
  const queues = new Map<string, Map<string, number>>();
  let disposed = false;
  const conversation = (context: string, thread: string) => {
    let threads = contexts.get(context);
    if (!threads) { threads = new Map(); contexts.set(context, threads); }
    let state = threads.get(thread);
    if (!state) {
      state = { busy: false, completed: false, failed: false, queue: queues.get(context)?.get(thread) ?? 0,
        turn: null, seenTurns: new Set(), waiting: new Set(), noticed: new Set() };
      threads.set(thread, state);
    }
    return state;
  };
  const emit = (context: string, thread: string, kind: ChatNotification['kind']) => options.notify({ kind, workspace: options.workspace,
    conversation: thread.startsWith('temporary-') ? 'Temporary chat' : `Chat ${thread.slice(0, 12)}` }, context, thread);
  const cancel = (state: Conversation) => { clearTimeout(state.timer); state.timer = undefined; };
  const check = (context: string, thread: string, state: Conversation) => {
    cancel(state);
    if (!queues.has(context) || !state.completed || state.busy || state.queue || state.waiting.size) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (disposed || state.busy || state.queue || state.waiting.size || !state.completed) return;
      state.completed = false; emit(context, thread, 'completed');
    }, options.delayMs ?? 350);
    state.timer.unref?.();
  };
  return {
    event(context: string, value: unknown) {
      if (disposed) return;
      const event = inputRecord(value); if (!event) return;
      const request = inputRecord(event.approval) ?? inputRecord(event.request);
      const thread = typeof event.threadId === 'string' ? event.threadId : request?.threadId;
      if (typeof thread !== 'string' || !thread) return;
      const type = event.type;
      if (!['turn-started', 'turn-completed', 'error', 'approval-requested', 'approval-resolved',
        'user-input-requested', 'user-input-resolved', 'assistant-question'].includes(String(type))) return;
      const state = conversation(context, thread);
      const turn = typeof event.turnId === 'string' ? event.turnId : null;
      if (type === 'turn-started') {
        if (turn && state.seenTurns.has(turn)) return;
        if (turn) {
          state.seenTurns.add(turn);
          if (state.seenTurns.size > 100) state.seenTurns.delete(state.seenTurns.values().next().value!);
        }
        state.turn = turn;
        if (!state.busy) { state.failed = false; state.waiting.clear(); state.noticed.clear(); }
        state.busy = true; state.completed = false; cancel(state); return;
      }
      if (turn && state.turn && turn !== state.turn) return;
      if (type === 'approval-requested' || type === 'user-input-requested' || type === 'assistant-question') {
        const id = String(request?.id ?? event.itemId ?? 'question');
        if (state.noticed.has(id)) return;
        state.noticed.add(id); state.waiting.add(id); cancel(state); emit(context, thread, 'attention'); return;
      }
      if (type === 'approval-resolved' || type === 'user-input-resolved') {
        state.waiting.delete(String(event.approvalId ?? event.requestId)); check(context, thread, state); return;
      }
      if (type === 'error' || (type === 'turn-completed' && event.status === 'failed')) {
        if (state.busy && !state.failed) { state.failed = true; emit(context, thread, 'failed'); }
        state.busy = false; state.completed = false; cancel(state); return;
      }
      if (type === 'turn-completed') {
        if (!state.busy) return;
        state.busy = false; state.completed = event.status === 'completed'; check(context, thread, state);
      }
    },
    queue(context: string, entries: { threadId: string; count: number }[]) {
      if (disposed) return;
      const counts = new Map(entries.map(entry => [entry.threadId, entry.count]));
      queues.set(context, counts);
      for (const [thread, state] of contexts.get(context) ?? []) {
        state.queue = counts.get(thread) ?? 0; check(context, thread, state);
      }
    },
    remove(context: string) {
      for (const state of contexts.get(context)?.values() ?? []) cancel(state);
      contexts.delete(context); queues.delete(context);
    },
    dispose() { disposed = true; for (const threads of contexts.values()) for (const state of threads.values()) cancel(state); contexts.clear(); queues.clear(); },
  };
}
