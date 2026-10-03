import { createHash } from 'node:crypto';
import { AgentStore, type Task } from './store.ts';
import { identifier, questionDeadline, type CollaborationMessage, type CollaborationState } from './collaboration-contract.ts';

export const questionClosed = (c: CollaborationState, id: string) =>
  c.outgoing.some(m => m.kind === 'question_closed' && m.questionId === id)
  || c.incoming.some(m => m.kind === 'question_closed' && m.questionId === id);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type State = ReturnType<AgentStore['snapshot']>;

function ownerQuestion(state: State, agentId: string, taskId: string, roomId: string, questionId: string) {
  identifier(taskId); identifier(roomId); identifier(questionId);
  const task = state.tasks.find(t => t.id === taskId);
  const question = state.collaboration.outgoing.find(m => m.id === questionId && m.kind === 'question' && m.taskId === taskId && m.roomId === roomId && m.from === agentId);
  if (!task?.goal || task.roomId !== roomId || task.consultation || task.verification || !question) throw new Error('Unknown room goal question.');
  return { task, question };
}

function assertWaiting(task: Task, c: CollaborationState, questionId: string) {
  if (questionClosed(c, questionId)) throw new Error('This question is already closed.');
  if (task.status !== 'waiting' || task.goal?.phase !== 'waiting') throw new Error('Only a waiting goal question can be changed. Refresh its state.');
  if (c.incoming.some(m => m.kind === 'reply' && m.questionId === questionId)) throw new Error('An answer already arrived. Refresh the question.');
}

function blockWithoutPending(task: Task, c: CollaborationState, reason: string) {
  const outstanding = c.outgoing.some(m => m.taskId === task.id && ['question', 'verification_request'].includes(m.kind)
    && !questionClosed(c, m.id) && !c.incoming.some(r => r.questionId === m.id && ['reply', 'verification_result'].includes(r.kind) && c.consumed.includes(r.id)));
  // Never overwrite an active turn or an execution with an unknown outcome.
  if (!outstanding && task.status === 'waiting' && task.goal?.phase === 'waiting') {
    task.goal = { ...task.goal, phase: 'blocked', pending: null };
    task.status = 'interrupted'; task.error = reason;
  }
}

/** Run inside the same transaction as answer receipt, before accepting new answers. */
export function expireQuestions(state: State, agentId: string, now: number) {
  const c = state.collaboration;
  for (const q of c.outgoing.filter(m => m.kind === 'question' && m.from === agentId)) {
    const deadline = c.questionDeadlines?.[q.id];
    if (!deadline || Date.parse(deadline) > now || questionClosed(c, q.id)
      || c.incoming.some(m => m.kind === 'reply' && m.questionId === q.id)) continue;
    if (c.outgoing.length >= 10_000) throw new Error('Collaboration history limit reached.');
    c.outgoing.push({ ...q, id: digest(`close/${q.id}`), kind: 'question_closed', closureReason: 'expired',
      text: `Question expired at ${deadline}. Late replies are recorded but do not resume the goal.` });
  }
  for (const task of state.tasks) {
    if (c.outgoing.some(m => m.taskId === task.id && m.kind === 'question_closed' && m.closureReason === 'expired')) {
      blockWithoutPending(task, c, 'No pending questions remain after expiry. Review the goal and send a follow-up to resume.');
    }
  }
}

export function setQuestionDeadline(store: AgentStore, agentId: string, taskId: string, roomId: string, questionId: string, value: unknown, now = Date.now()) {
  const deadline = questionDeadline(value);
  store.transaction(state => { expireQuestions(state, agentId, now); });
  store.transaction(state => {
    const { task } = ownerQuestion(state, agentId, taskId, roomId, questionId), c = state.collaboration;
    assertWaiting(task, c, questionId);
    if (deadline !== null && Date.parse(deadline) <= now) throw new Error('Choose a future question deadline.');
    c.questionDeadlines ??= {};
    if (deadline === null) delete c.questionDeadlines[questionId];
    else c.questionDeadlines[questionId] = deadline;
  });
  return store.task(taskId)!;
}

/** The owner serializes closure, replacement and goal state in one durable transaction. */
export function closeQuestion(store: AgentStore, agentId: string, taskId: string, roomId: string, questionId: string, recipient: string | null) {
  identifier(taskId); identifier(roomId); identifier(questionId);
  if (recipient !== null) identifier(recipient);
  store.transaction(state => { expireQuestions(state, agentId, Date.now()); });
  store.transaction(state => {
    const { task, question } = ownerQuestion(state, agentId, taskId, roomId, questionId), c = state.collaboration;
    const replacementId = recipient ? digest(`redirect/${questionId}/${recipient}`) : null;
    const text = recipient ? `Question reassigned by user to ${recipient}; replacement question: ${replacementId}.` : 'Question cancelled by user.';
    const previous = c.outgoing.find(m => m.kind === 'question_closed' && m.questionId === questionId);
    if (previous) {
      if (previous.text !== text) throw new Error('This question was already closed with a different action.');
      return;
    }
    assertWaiting(task, c, questionId);
    if (recipient && (recipient === question.to || recipient === agentId || !c.peers.some(p => p.id === recipient)
      || !c.rooms?.[roomId]?.includes(agentId) || !c.rooms[roomId]?.includes(recipient))) throw new Error('Choose a different invited peer.');
    if (recipient && c.outgoing.filter(m => m.taskId === taskId && ['question', 'verification_request'].includes(m.kind)).length >= 16) throw new Error('Question budget reached.');
    if (c.outgoing.length + (recipient ? 2 : 1) > 10_000) throw new Error('Collaboration history limit reached.');
    const closure: CollaborationMessage = { ...question, id: digest(`close/${questionId}`), kind: 'question_closed', text };
    c.outgoing.push(closure);
    if (recipient && replacementId) {
      c.outgoing.push({ ...question, id: replacementId, questionId: replacementId, to: recipient });
      if (c.questionDeadlines?.[questionId]) c.questionDeadlines[replacementId] = c.questionDeadlines[questionId];
    }
    blockWithoutPending(task, c, 'The last waiting question was cancelled. Review the goal and send a follow-up to resume.');
  });
  return store.task(taskId)!;
}
