import type { RoomMessage } from '../../../../shared/agent-chats';

/** Only adjacent receipts with explicit task and native turn identities share a header. */
export function continuesResponse(previous: RoomMessage | undefined, message: RoomMessage | undefined): boolean {
  if (!previous || !message || previous.sender === 'user' || message.kind !== 'message' || previous.kind !== 'message') return false;
  return !!message.taskId && !!message.activity?.turnId
    && previous.roomId === message.roomId && previous.sender === message.sender
    && previous.taskId === message.taskId && previous.activity?.turnId === message.activity.turnId
    && previous.recipient === message.recipient && previous.threadId === message.threadId
    && previous.replyTo === message.replyTo && previous.questionId === message.questionId;
}

export function timelineIndex(messages: RoomMessage[]) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const tasks = new Map<string, RoomMessage>();
  const requests = new Map<string, RoomMessage>();
  const exchanges = new Map<string, RoomMessage[]>();
  for (const message of messages) {
    const task = JSON.stringify([message.roomId, message.taskId]);
    if (message.sender === 'user' && message.taskId && !tasks.has(task)) tasks.set(task, message);
    const request = JSON.stringify([message.roomId, message.taskId, message.recipient]);
    if (message.sender === 'user' && message.taskId && !requests.has(request)) requests.set(request, message);
    const question = message.questionId ?? message.id;
    const key = JSON.stringify([message.roomId, question]);
    const entries = exchanges.get(key) ?? [];
    entries.push(message); exchanges.set(key, entries);
  }
  return {
    get(id: string | null | undefined) { return id ? byId.get(id) : undefined; },
    request(message: RoomMessage) { return requests.get(JSON.stringify([message.roomId, message.taskId, message.sender])); },
    root(message: RoomMessage) {
      if (message.sender === 'user' && (message.kind === 'goal' || message.dialogue) && !message.threadId) return message;
      const thread = message.threadId ? byId.get(message.threadId) : undefined;
      return thread?.roomId === message.roomId ? thread : tasks.get(JSON.stringify([message.roomId, message.taskId]));
    },
    exchange(message: RoomMessage) { return exchanges.get(JSON.stringify([message.roomId, message.questionId ?? message.id])) ?? []; },
  };
}
export type TimelineIndex = ReturnType<typeof timelineIndex>;

/** Automatic task context appears once; explicit replies retain their own quote. */
export function timelineContexts(messages: RoomMessage[], index: TimelineIndex) {
  const contexts = new Map<string, RoomMessage>();
  const seen = new Set<string>();
  const multipleTasks = currentWork(messages).length > 1;
  for (const message of messages) {
    const explicit = index.get(message.replyTo)
      ?? (message.questionId !== message.id ? index.get(message.questionId) : undefined);
    const root = index.root(message);
    if (explicit?.roomId === message.roomId) {
      contexts.set(message.id, explicit);
      if (explicit.id === root?.id) seen.add(root.id);
    } else if (multipleTasks && root && root.id !== message.id && !seen.has(root.id)) {
      contexts.set(message.id, root); seen.add(root.id);
    }
  }
  return contexts;
}

export function roomTimeline(messages: RoomMessage[], roomId: string | null) {
  return messages.filter(message => message.roomId === roomId).sort((a, b) => {
    const first = Date.parse(a.createdAt), second = Date.parse(b.createdAt);
    return Number.isFinite(first) && Number.isFinite(second) ? first - second : 0;
  });
}
export function messageRoot(message: RoomMessage, messages: RoomMessage[]) {
  const candidates = messages.filter(m => m.roomId === message.roomId);
  if (message.sender === 'user' && (message.kind === 'goal' || message.dialogue) && !message.threadId) return message;
  return candidates.find(m => m.id === message.threadId)
    ?? candidates.find(m => m.sender === 'user' && m.taskId && m.taskId === message.taskId);
}
export function exchangeLabel(message: RoomMessage, messages: RoomMessage[], index?: TimelineIndex) {
  if (message.userQuestion) return message.userQuestion.answered ? 'Answered' : 'Needs your answer';
  if (message.sender === 'user' && message.replyTo && ['queued', 'sending', 'sent'].includes(message.status ?? '')) return 'Follow-up queued';
  if (message.status && ['failed', 'unknown', 'closed', 'expired', 'late reply · not applied'].includes(message.status)) return message.status;
  if (['question', 'verification_request', 'work_request'].includes(message.kind)) {
    const replies = index ? index.exchange(message).filter(m => m.questionId === (message.questionId ?? message.id))
      : messages.filter(m => m.roomId === message.roomId && m.questionId === (message.questionId ?? message.id));
    if (replies.some(m => m.kind === 'question_closed')) return 'Closed';
    if (replies.some(m => ['reply', 'verification_result', 'work_result'].includes(m.kind)
      && !['late reply · not applied', 'failed', 'unknown'].includes(m.status ?? ''))) return 'Answered';
    const saved = (index ? index.root(message) : messageRoot(message, messages))?.goalProgress?.questions?.find(q => `peer_${q.id}` === message.id || q.id === message.questionId);
    if (saved) return ({ answered: 'Answered', closed: 'Closed', expired: 'Expired', waiting: 'Awaiting reply' })[saved.status];
    return message.questionId ? 'Awaiting reply' : 'Reply status unavailable';
  }
  return null;
}
export function currentWork(messages: RoomMessage[]) {
  const tasks = new Map<string, RoomMessage>();
  for (const message of messages) {
    if (message.sender !== 'user' || !message.taskId || !message.recipient) continue;
    const key = `${message.recipient}/${message.taskId}`;
    if (!tasks.has(key) || message.goalProgress) tasks.set(key, message);
  }
  for (const message of messages) {
    if (!message.relatedTask || !message.executionStatus) continue;
    const { agentId, taskId } = message.relatedTask, key = `${agentId}/${taskId}`;
    if (!tasks.has(key)) tasks.set(key, { ...message, recipient: agentId, taskId, status: message.executionStatus,
      goalProgress: undefined, dialogue: message.inspection?.dialogue });
  }
  return [...tasks.values()].filter(message => !['completed', 'held'].includes(message.goalProgress?.phase ?? message.status ?? ''));
}
