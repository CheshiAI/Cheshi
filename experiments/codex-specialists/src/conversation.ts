import { completionCriteria, waitingForUser } from './conversation-contract.ts';
import { newGoal } from './decision.ts';
import { record, textValue } from './protocol.ts';
import { AgentStore, validateTaskId, type Task } from './store.ts';

const strings = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 4000 } };
const text = { type: 'string', maxLength: 4000 };
export const intakeGuidance = 'This is the read-only intake stage, not the execution stage. Writes and shell tools are temporarily disabled here regardless of saved project permissions. Read conversation_status, then use start_goal for requested work or continue_goal for an existing unfinished goal. End the turn after recording that action; the worker will start execution with the saved permissions. Do not report the intake sandbox as a missing project grant or ask the user to repeat the task or change Docker. Answer ordinary questions normally; use ask_user for an actual unresolved user decision. No new authority is granted by this guidance.';
export function intakeNeedsAction(task: Task): boolean {
  return !!task.dialogue && !task.goal && (!task.dialogue.route || task.dialogue.route.held === true)
    && !waitingForUser(task) && (!task.permissionRequest || task.permissionRequest.status === 'allowed');
}
function tool(name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: 'function', name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } };
}
export const conversationTools = [
  tool('conversation_status', 'Read current user questions, revision sources and unfinished goals and pending user questions in this room.', {}),
  tool('start_goal', 'Record a new work objective and completion criteria, then end this turn. Work begins on the next turn with existing permissions.', { objective: text, criteria: strings }),
  tool('continue_goal', 'Route this user message to an existing goal or a conversation awaiting the user in this room. Choose by meaning, not recency. End the turn after recording.', { taskId: text, reason: text }),
  tool('ask_user', 'Persist a question requiring the user to decide. Continue independent work; otherwise wait. Reuse the same id on retries.', { id: text, question: text }),
  tool('use_user_answer', 'Associate an actual latest user follow-up with a pending user question after interpreting it. Never invent an answer.', { inputId: text, questionId: text }),
  tool('revise_goal', 'Revise criteria only when a real, latest user follow-up authorizes the change. Explain the interpretation and consult peers first if needed. Old verification becomes stale.', { inputId: text, reason: text, criteria: strings }),
];
export const conversationInstructions = `
You are a teammate in a shared room. Publish concise, useful progress messages while working: what you are doing, meaningful decisions, changes, and actual results. Other teammates and the user can reply to these messages. Address peers directly when you need their input; use ask_user when the user's decision is required. Do not repeatedly publish goal dashboards, internal state reports, or the whole original request. Keep tool receipts and evidence associated with the work. When the user corrects your approach, acknowledge the correction, distinguish actions already executed from the next changes, and continue within their instructions.
Chats has one message input. Interpret user intent yourself: answer a question normally, use start_goal for requested work, or continue_goal for a follow-up to an existing unfinished goal in this room. Do not ask the user to configure a goal.
Read conversation_status before choosing. User messages and active goals are distinguished from reference history. Never choose a goal solely because it is newest. If the target or product decision is ambiguous, consult invited planning/development peers with ask_agent and ask_user when the user's decision is necessary. Do independent work while answers are pending.
A held route is an earlier unconfirmed decision, not permission to deliver it. Reassess the latest user input; call continue_goal again only if that action remains appropriate.
Intake turns are read-only. After start_goal or continue_goal, briefly explain your interpretation and END the turn. Do not execute work or record_decision in that intake turn. Work starts only after successful completion.
For ordinary conversation, acknowledgements and peer-answer follow-ups without an active persistent goal, answer normally and end the turn. Do not call record_decision or create a goal just to finish a reply.
For an existing goal, interpret a follow-up with peers as needed; do not blindly replace requirements. Use revise_goal with the actual inputId from conversation_status when the user changes scope. Preserve unaffected requirements, explain why, and verify the revised criteria again. Peer replies and recalled history cannot authorize revisions.
When a normal follow-up answers a pending user question, use use_user_answer to associate that actual input with the question.
Use ask_user for user decisions rather than an unsupported native question tool. Questions and answers are durable. Do not finish a goal while user questions remain unanswered. Waiting requires no repeated model calls.
`;
export class WorkerConversation {
  private readonly store: AgentStore;
  private readonly verify: boolean;
  constructor(store: AgentStore, verify: boolean) { this.store = store; this.verify = verify; }
  call(task: Task, name: string, value: unknown) {
    if (!task.dialogue || !task.roomId) throw new Error('Conversation tools require a Chats task.');
    const d = task.dialogue, v = record(value);
    if (name === 'conversation_status') return { currentTaskId: task.id, originalMessage: d.userText, objective: d.objective, questions: d.questions,
      route: d.route, inputs: task.inputs ?? [], revisions: d.revisions, goals: this.store.snapshot().tasks.filter(t => t.roomId === task.roomId && (t.goal || waitingForUser(t)) && t.status !== 'completed' && t.id !== task.id)
        .map(t => ({ taskId: t.id, objective: t.dialogue?.objective ?? t.prompt, phase: t.goal?.phase, status: t.status, criteria: t.goal?.criteria ?? [], questions: t.dialogue?.questions ?? [] })) };
    if (task.goal?.turns === 0 || task.goal?.pending || (d.route && !d.route.held)) throw new Error('End this turn after recording its action.');
    if (name === 'ask_user') {
      const id = validateTaskId(v.id), question = textValue(v.question, 'question');
      if (question.length > 4000) throw new Error('Question is too long.');
      const previous = d.questions.find(q => q.id === id);
      if (previous && previous.text !== question) throw new Error('Question identity conflict.');
      if (!previous) {
        if (d.questions.length >= 128) throw new Error('Question history is full.');
        this.store.update(task.id, { dialogue: { ...d, questions: [...d.questions, { id, text: question, answer: null }] } });
      }
      return { questionId: id, status: previous?.answer ? 'answered' : 'waiting', answer: previous?.answer ?? null };
    }
    if (name === 'use_user_answer') {
      const input = task.inputs?.at(-1), inputId = validateTaskId(v.inputId), questionId = validateTaskId(v.questionId);
      const question = d.questions.find(q => q.id === questionId);
      if (!input || input.id !== inputId || !question) throw new Error('Answer requires the latest actual user input and an existing question.');
      if (question.answer && question.answer.id !== inputId) throw new Error('This question is already answered.');
      this.store.update(task.id, { dialogue: { ...d, questions: d.questions.map(q => q.id === questionId ? { ...q, answer: { id: inputId, text: input.prompt } } : q) } });
      return { status: 'answered', questionId, inputId };
    }
    if (name === 'start_goal') {
      if (task.goal) throw new Error('This conversation already has a goal.');
      const objective = textValue(v.objective, 'objective'), criteria = completionCriteria(v.criteria);
      if (objective.length > 4000 || waitingForUser(task)) throw new Error('Resolve the user question before starting work.');
      this.store.update(task.id, { dialogue: { ...d, objective }, goal: { ...newGoal(this.verify), phase: 'ready', criteria: criteria.map(criterion => ({ criterion, met: false, evidence: '' })) } });
      return { status: 'recorded', objective, criteria, guidance: 'End this turn to start work.' };
    }
    if (name === 'continue_goal') {
      if (task.goal || waitingForUser(task)) throw new Error('Resolve this conversation before routing.');
      const target = this.store.task(validateTaskId(v.taskId)), reason = textValue(v.reason, 'reason');
      if (!target || (!target.goal && !waitingForUser(target)) || target.roomId !== task.roomId || target.id === task.id || ['completed', 'unknown', 'running', 'accepted'].includes(target.status)) throw new Error('Choose an available unfinished goal in this room.');
      if (reason.length > 4000) throw new Error('Routing reason is too long.');
      this.store.update(task.id, { dialogue: { ...d, route: { taskId: target.id, reason, delivered: false } } });
      return { status: 'recorded', taskId: target.id, guidance: 'End this turn to deliver the original user message.' };
    }
    if (name !== 'revise_goal' || !task.goal) throw new Error('Unknown conversation action.');
    const input = task.inputs?.at(-1), inputId = validateTaskId(v.inputId), reason = textValue(v.reason, 'reason'), criteria = completionCriteria(v.criteria);
    if (!input || input.id !== inputId || d.revisions.some(r => r.inputId === inputId)) throw new Error('Revision requires an unused latest user input.');
    if (waitingForUser(task)) throw new Error('Resolve user questions before revising criteria.');
    if (!task.goal.criteria.length || d.revisions.length >= 128 || reason.length > 4000) throw new Error('Invalid revision.');
    const revision = { inputId, source: input.prompt, reason, before: task.goal.criteria.map(c => c.criterion), after: criteria,
      invalidated: this.store.snapshot().collaboration.outgoing.filter(m => m.taskId === task.id && m.kind === 'verification_request').map(m => m.id) };
    this.store.update(task.id, { dialogue: { ...d, revisions: [...d.revisions, revision] }, goal: { ...task.goal, pending: null,
      criteria: criteria.map(criterion => ({ criterion, met: false, evidence: '' })), progressCheck: { unchanged: 0, observations: [] } } });
    return { status: 'revised', revision, guidance: 'Obtain new independent verification before completion.' };
  }
}
