import { collaborationTextLimit, isWorkKind, parseWorkMessage, type WorkKind } from './work-contract.ts';
import { assertVerificationContextScope, verificationRequest, verificationResult } from './verification-contract.ts';
import { record, textValue } from './protocol.ts';

export interface Peer { id: string; name: string; role: string; fileWrite?: boolean; workProtocol?: 1 }
export interface CollaborationMessage {
  id: string; kind: WorkKind | 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result'; from: string; to: string;
  roomId?: string; taskId: string; questionId: string; text: string;
  closureReason?: 'expired';
}
export interface CollaborationState {
  questionDeadlines?: Record<string, string>;
  rooms?: Record<string, string[]>;
  peers: Peer[];
  outgoing: CollaborationMessage[];
  acknowledged: string[];
  incoming: CollaborationMessage[];
  consumed: string[];
}
export const emptyCollaboration = (): CollaborationState => ({ peers: [], outgoing: [], acknowledged: [], incoming: [], consumed: [] });
export function appendOutgoing(state: CollaborationState, input: CollaborationMessage): void {
  const item = message(input), previous = state.outgoing.find(m => m.id === item.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Request id already belongs to different content.');
  if (previous) return;
  if (state.outgoing.length >= 10_000) throw new Error('Collaboration history limit reached.');
  state.outgoing.push(item);
}
export function identifier(value: unknown): string {
  const text = textValue(value, 'collaboration identifier');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(text)) throw new Error('Invalid collaboration identifier.');
  return text;
}
export function message(value: unknown): CollaborationMessage {
  const v = record(value);
  if (!isWorkKind(v.kind) && !['question', 'question_closed', 'reply', 'verification_request', 'verification_result'].includes(String(v.kind))) throw new Error('Invalid collaboration message kind.');
  const text = textValue(v.text, 'message');
  if ((text.length > collaborationTextLimit(v.kind))) throw new Error('Collaboration message is too long.');
  if (isWorkKind(v.kind)) {
    if (!v.roomId || !/^[a-f0-9]{64}$/.test(String(v.questionId))) throw new Error('Invalid delegated work identity.');
    parseWorkMessage(v.kind, JSON.parse(text));
  }
  if (v.kind === 'verification_request') assertVerificationContextScope(verificationRequest(JSON.parse(text)), {
    from: identifier(v.from), taskId: identifier(v.taskId), ...(v.roomId === undefined ? {} : { roomId: identifier(v.roomId) }),
  });
  if (v.kind === 'verification_result') verificationResult(JSON.parse(text));
  if (v.closureReason !== undefined && (v.kind !== 'question_closed' || v.closureReason !== 'expired')) throw new Error('Invalid question closure reason.');
  return { id: identifier(v.id), kind: v.kind as CollaborationMessage['kind'], from: identifier(v.from), to: identifier(v.to),
    ...(v.closureReason === 'expired' ? { closureReason: 'expired' as const } : {}),
    ...(v.roomId === undefined ? {} : { roomId: identifier(v.roomId) }), taskId: identifier(v.taskId), questionId: identifier(v.questionId), text };
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid collaboration list.');
  return value;
}
export function peers(value: unknown): Peer[] {
  return array(value).map(item => {
    const v = record(item);
    return { id: identifier(v.id), name: textValue(v.name, 'peer name').slice(0, 200), role: textValue(v.role, 'peer role').slice(0, 100), ...(v.fileWrite === undefined ? {} : { fileWrite: v.fileWrite === true }), ...(v.workProtocol === 1 ? { workProtocol: 1 as const } : {}) };
  });
}
export function collaborationState(value: unknown): CollaborationState {
  const v = record(value);
  const deadlines = v.questionDeadlines === undefined ? {} : record(v.questionDeadlines);
  if (Object.keys(deadlines).length > 10_000) throw new Error('Too many question deadlines.');
  return { questionDeadlines: Object.fromEntries(Object.entries(deadlines).map(([id, date]) => {
    const parsed = questionDeadline(date);
    if (parsed === null) throw new Error('Invalid saved question deadline.');
    return [identifier(id), parsed];
  })), rooms: roomRoster(v.rooms), peers: peers(v.peers), outgoing: array(v.outgoing).map(message), incoming: array(v.incoming).map(message),
    acknowledged: array(v.acknowledged).map(identifier), consumed: array(v.consumed).map(identifier) };
}

export function questionDeadline(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Invalid question deadline.');
  return value;
}

export function roomRoster(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(record(value)).map(([id, members]) => [identifier(id), array(members).map(identifier)]));
}
