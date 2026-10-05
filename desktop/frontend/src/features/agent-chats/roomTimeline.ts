import type { RoomMessage } from '../../../../shared/agent-chats';

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
export function exchangeLabel(message: RoomMessage, messages: RoomMessage[]) {
  if (message.userQuestion) return message.userQuestion.answered ? 'Answered' : 'Needs your answer';
  if (message.sender === 'user' && message.replyTo && ['queued', 'sending', 'sent'].includes(message.status ?? '')) return 'Follow-up queued';
  if (message.status && ['failed', 'unknown', 'closed', 'expired', 'late reply · not applied'].includes(message.status)) return message.status;
  if (['question', 'verification_request', 'work_request'].includes(message.kind)) {
    const replies = messages.filter(m => m.roomId === message.roomId && m.questionId === (message.questionId ?? message.id));
    if (replies.some(m => m.kind === 'question_closed')) return 'Closed';
    if (replies.some(m => ['reply', 'verification_result', 'work_result'].includes(m.kind)
      && !['late reply · not applied', 'failed', 'unknown'].includes(m.status ?? ''))) return 'Answered';
    const saved = messageRoot(message, messages)?.goalProgress?.questions?.find(q => `peer_${q.id}` === message.id || q.id === message.questionId);
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
export function workLabel(message: RoomMessage) {
  const state = message.goalProgress?.phase ?? message.status;
  if (state === 'unknown' || message.status === 'unknown') return 'Execution needs checking';
  if (state === 'unavailable') return ['blocked', 'failed', 'interrupted'].includes(message.status ?? '')
    ? 'Needs attention · current task state unavailable' : 'Task state unavailable';
  if (state === 'blocked' || state === 'failed' || state === 'interrupted') return 'Needs attention';
  if (message.dialogue?.questions.some(q => !q.answer)) return 'Waiting for your answer';
  if (message.worker?.phase === 'starting') return 'Starting';
  if (message.worker?.phase === 'disabled') return 'Stopped · start in Agents';
  if (message.worker?.phase === 'error') return 'Worker unavailable';
  if (state === 'waiting') return 'Waiting for a reply';
  if (message.worker?.phase === 'sleeping') return 'Sleeping · wakes on request';
  return ({ queued: 'Queued', sending: 'Sending', sent: 'Accepted', running: 'Working', active: 'Working', ready: 'Continuing' })[state ?? ''] ?? 'Checking';
}
