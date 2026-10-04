import { record, textValue } from './protocol.ts';

export interface UserQuestion { id: string; text: string; answer: { id: string; text: string } | null }
export interface RequirementRevision { inputId: string; source: string; reason: string; before: string[]; after: string[]; invalidated: string[] }
export interface ConversationState {
  userText: string; questions: UserQuestion[]; revisions: RequirementRevision[];
  objective?: string; route?: { taskId: string; reason: string; delivered: boolean; held?: true };
}
const id = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('Invalid conversation identity.');
  return value;
};
function text(value: unknown, max = 16000): string {
  const result = textValue(value, 'conversation text');
  if (result.length > max) throw new Error('Conversation text is too long.');
  return result;
}
function list<T>(value: unknown, parse: (v: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid conversation records.');
  return value.map(parse);
}
export function completionCriteria(value: unknown): string[] {
  const result = list(value, v => text(v, 4000).trim(), 16);
  if (!result.length || result.some(v => !v) || new Set(result).size !== result.length) throw new Error('Provide distinct completion criteria.');
  return result;
}
export function parseConversation(value: unknown): ConversationState {
  const v = record(value);
  const result: ConversationState = { userText: text(v.userText), questions: list(v.questions, raw => {
    const q = record(raw), a = q.answer === null ? null : record(q.answer);
    return { id: id(q.id), text: text(q.text, 4000), answer: a ? { id: id(a.id), text: text(a.text) } : null };
  }, 128), revisions: list(v.revisions, raw => {
    const r = record(raw);
    return { inputId: id(r.inputId), source: text(r.source), reason: text(r.reason, 4000), before: completionCriteria(r.before), after: completionCriteria(r.after), invalidated: list(r.invalidated, id, 10000) };
  }, 128), ...(v.objective === undefined ? {} : { objective: text(v.objective, 4000) }),
  ...(v.route === undefined ? {} : { route: (() => { const r = record(v.route); if (typeof r.delivered !== 'boolean' || (r.held !== undefined && r.held !== true)) throw new Error('Invalid route receipt.'); return { taskId: id(r.taskId), reason: text(r.reason, 4000), delivered: r.delivered, ...(r.held === true ? { held: true as const } : {}) }; })() }) };
  if (new Set(result.questions.map(q => q.id)).size !== result.questions.length || new Set(result.revisions.map(r => r.inputId)).size !== result.revisions.length) throw new Error('Duplicate conversation record.');
  return result;
}
export const waitingForUser = (task: { dialogue?: ConversationState }) => task.dialogue?.questions.some(q => !q.answer) === true;
export const staleVerification = (task: { dialogue?: ConversationState }, id: string) => task.dialogue?.revisions.some(r => r.invalidated.includes(id)) === true;
