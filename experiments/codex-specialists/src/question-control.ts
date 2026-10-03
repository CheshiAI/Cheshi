import { createHash } from 'node:crypto';
import { AgentStore } from './store.ts';
import { identifier, type CollaborationMessage, type CollaborationState } from './collaboration-contract.ts';

export const questionClosed = (c: CollaborationState, id: string) =>
  c.outgoing.some(m => m.kind === 'question_closed' && m.questionId === id)
  || c.incoming.some(m => m.kind === 'question_closed' && m.questionId === id);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** The owner serializes closure, replacement and goal state in one durable transaction. */
export function closeQuestion(store: AgentStore, agentId: string, taskId: string, roomId: string, questionId: string, recipient: string | null) {
  identifier(taskId); identifier(roomId); identifier(questionId);
  if (recipient !== null) identifier(recipient);
  store.transaction(state => {
    const task = state.tasks.find(t => t.id === taskId), c = state.collaboration;
    const question = c.outgoing.find(m => m.id === questionId && m.kind === 'question' && m.taskId === taskId && m.roomId === roomId && m.from === agentId);
    if (!task?.goal || task.roomId !== roomId || task.consultation || task.verification || !question) throw new Error('Unknown room goal question.');
    const replacementId = recipient ? digest(`redirect/${questionId}/${recipient}`) : null;
    const text = recipient ? `Question reassigned by user to ${recipient}; replacement question: ${replacementId}.` : 'Question cancelled by user.';
    const previous = c.outgoing.find(m => m.kind === 'question_closed' && m.questionId === questionId);
    if (previous) {
      if (previous.text !== text) throw new Error('This question was already closed with a different action.');
      return;
    }
    if (task.status !== 'waiting' || task.goal.phase !== 'waiting') throw new Error('Only a waiting goal question can be changed. Refresh its state.');
    if (c.incoming.some(m => m.kind === 'reply' && m.questionId === questionId)) throw new Error('An answer already arrived. Refresh the question.');
    if (recipient && (recipient === question.to || recipient === agentId || !c.peers.some(p => p.id === recipient)
      || !c.rooms?.[roomId]?.includes(agentId) || !c.rooms[roomId]?.includes(recipient))) throw new Error('Choose a different invited peer.');
    if (recipient && c.outgoing.filter(m => m.taskId === taskId && ['question', 'verification_request'].includes(m.kind)).length >= 16) throw new Error('Question budget reached.');
    if (c.outgoing.length + (recipient ? 2 : 1) > 10_000) throw new Error('Collaboration history limit reached.');
    const closure: CollaborationMessage = { ...question, id: digest(`close/${questionId}`), kind: 'question_closed', text };
    c.outgoing.push(closure);
    if (recipient && replacementId) c.outgoing.push({ ...question, id: replacementId, questionId: replacementId, to: recipient });
    const outstanding = c.outgoing.some(m => m.taskId === taskId && ['question', 'verification_request'].includes(m.kind)
      && !questionClosed(c, m.id) && !c.incoming.some(r => r.questionId === m.id && ['reply', 'verification_result'].includes(r.kind) && c.consumed.includes(r.id)));
    if (!outstanding) {
      task.goal = { ...task.goal, phase: 'blocked', pending: null };
      task.status = 'interrupted';
      task.error = 'The last waiting question was cancelled. Review the goal and send a follow-up to resume.';
    }
  });
  return store.task(taskId)!;
}
