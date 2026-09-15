import { chatSendFailure, type ChatSendResult } from './chatDraftRecovery';
import { normalizeSendResponse } from './model';

export interface ChatSendAttempt { clientMessageId: string; threadId: string | null; accepted: boolean }

export function observeChatSendAttempt(attempt: ChatSendAttempt | null, value: unknown): void {
  if (!attempt || !value || typeof value !== 'object') return;
  const event = value as Record<string, unknown>;
  if ((event.type === 'user-message' || event.type === 'turn-started')
    && event.clientMessageId === attempt.clientMessageId && typeof event.threadId === 'string') {
    attempt.accepted = true;
    attempt.threadId = event.threadId;
  }
  if (event.type === 'session-selected' && (attempt.threadId === null || attempt.threadId === event.previousThreadId) && typeof event.threadId === 'string') {
    attempt.threadId = event.threadId;
  }
}

export async function performChatSend(attempt: ChatSendAttempt, send: () => Promise<unknown>): Promise<ChatSendResult> {
  try {
    const response = await send();
    if (attempt.accepted) return { status: 'accepted' };
    const failure = chatSendFailure(response);
    if (failure) return failure;
    const { threadId } = normalizeSendResponse(response);
    attempt.threadId = threadId;
    attempt.accepted = true;
    return { status: 'accepted' };
  } catch (error) {
    return attempt.accepted ? { status: 'accepted' } : {
      status: 'unknown', message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Retry interruption after an already-starting send obtains its server thread. */
export async function cancelChatSend(
  threadId: string | null,
  stop: (threadId: string | null) => Promise<unknown>,
  pending?: { attempt: ChatSendAttempt; settled: Promise<void> },
): Promise<void> {
  let firstFailure: unknown;
  let failed = false;
  try { await stop(threadId); }
  catch (error) { failed = true; firstFailure = error; }
  if (pending) {
    await pending.settled;
    await stop(pending.attempt.threadId ?? threadId);
  } else if (failed) throw firstFailure;
}

export function createChatSendCompletion() {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  return { settled, finish };
}
