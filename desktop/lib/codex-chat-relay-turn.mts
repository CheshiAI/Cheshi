import type { CodexChatService } from './codex-chat-service.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

export class RelayCancellationError extends Error {}

/** Only completed assistant messages from this exact turn may be relayed. */
export async function runChatRelayTurn(service: CodexChatService, threadId: string, text: string, clientMessageId: string, signal: AbortSignal,
  onThreadChanged?: (threadId: string) => void): Promise<string> {
  signal.throwIfAborted();
  let turnId: string | null = null;
  const notifications: Record<string, unknown>[] = [];
  const cancellations = new Map<string, Promise<void>>();
  let cancellationError: string | null = null;
  const messages = new Map<string, string>();
  let resolveFinished!: (value: string) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<string>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  const cancelThread = () => {
    if (cancellations.has(threadId)) return;
    cancellations.set(threadId, service.cancelResponse(threadId).then(() => {}, (error: unknown) => {
      cancellationError = error instanceof Error ? error.message : String(error);
    }));
  };
  const adoptThread = (nextThreadId: string) => {
    if (nextThreadId === threadId) return;
    threadId = nextThreadId;
    onThreadChanged?.(threadId);
    if (signal.aborted) cancelThread();
  };
  const removeEvent = service.onEvent((event) => {
    if (turnId === null && event.type === 'session-selected' && event.previousThreadId === threadId) {
      const selected = stringValue(event.threadId);
      if (selected) adoptThread(selected);
    }
    if (event.threadId !== threadId || event.clientMessageId !== clientMessageId) return;
    if (event.type === 'error') rejectFinished(new Error(String(event.message ?? 'Relay response failed.')));
  });
  const acceptMessage = (value: unknown) => {
    const item = recordValue(value);
    if (item?.type !== 'agentMessage' || (item.phase != null && item.phase !== 'final_answer')) return;
    const id = stringValue(item.id);
    const content = stringValue(item.text);
    if (id && content?.trim()) messages.set(id, content.trim());
  };
  const consumeNotification = (notification: Record<string, unknown>) => {
    const params = recordValue(notification.params);
    const turn = recordValue(params?.turn);
    if (!params || params.threadId !== threadId || !turnId || (params.turnId ?? turn?.id) !== turnId) return;
    if (notification.method === 'item/completed') acceptMessage(params.item);
    if (notification.method !== 'turn/completed') return;
    if (turn?.status !== 'completed') {
      rejectFinished(new Error(stringValue(recordValue(turn?.error)?.message) ?? 'Relay response did not complete.'));
      return;
    }
    if (Array.isArray(turn.items)) for (const item of turn.items) acceptMessage(item);
    const output = [...messages.values()].join('\n\n');
    if (!output) rejectFinished(new Error('The relay response has no completed assistant output.'));
    else if (output.length > 64_000) rejectFinished(new Error('The relay response is too large to forward.'));
    else resolveFinished(output);
  };
  const removeNotification = service.client.onNotification((notification) => {
    if (notification.method !== 'item/completed' && notification.method !== 'turn/completed') return;
    // The acknowledgement may be the first evidence of a handoff. Filter the
    // buffered events by both the accepted thread and turn when it arrives.
    if (turnId === null) notifications.push(notification);
    else consumeNotification(notification);
  });
  const cancel = () => {
    rejectFinished(new Error('Relay stopped.'));
    cancelThread();
  };
  signal.addEventListener('abort', cancel, { once: true });
  service.emit({ type: 'user-message', threadId, clientMessageId, text, createdAt: Date.now() / 1_000 });
  const sending = service.sendMessage(text, clientMessageId, null, [], threadId, signal).then((result) => {
    const acceptedThreadId = stringValue(result.threadId);
    if (!acceptedThreadId) throw new Error('The relay response returned no thread identifier.');
    adoptThread(acceptedThreadId);
    turnId = result.turnId;
    if (!turnId) throw new Error('The relay response returned no turn identifier.');
    for (const notification of notifications) consumeNotification(notification);
    notifications.length = 0;
  });
  try {
    const [, output] = await Promise.all([sending, finished]);
    signal.throwIfAborted();
    return output;
  } finally {
    // Keep the pane reserved until a pending turn/start has accepted cancellation.
    await sending.catch((error: unknown) => {
      if (signal.aborted && error !== signal.reason) {
        cancellationError = error instanceof Error ? error.message : String(error);
      }
    });
    removeEvent();
    removeNotification();
    signal.removeEventListener('abort', cancel);
    await Promise.all(cancellations.values());
    if (cancellationError !== null) throw new RelayCancellationError(`Could not confirm relay cancellation: ${cancellationError}`);
  }
}
