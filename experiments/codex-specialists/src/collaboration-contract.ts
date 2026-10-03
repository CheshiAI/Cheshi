import { verificationRequest, verificationResult } from './verification-contract.ts';
import { record, textValue } from './protocol.ts';

export interface Peer { id: string; name: string; role: string }
export interface CollaborationMessage {
  id: string; kind: 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result'; from: string; to: string;
  roomId?: string; taskId: string; questionId: string; text: string;
}
export interface CollaborationState {
  rooms?: Record<string, string[]>;
  peers: Peer[];
  outgoing: CollaborationMessage[];
  acknowledged: string[];
  incoming: CollaborationMessage[];
  consumed: string[];
}
export const emptyCollaboration = (): CollaborationState => ({ peers: [], outgoing: [], acknowledged: [], incoming: [], consumed: [] });
export function identifier(value: unknown): string {
  const text = textValue(value, 'collaboration identifier');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(text)) throw new Error('Invalid collaboration identifier.');
  return text;
}
export function message(value: unknown): CollaborationMessage {
  const v = record(value);
  if (!['question', 'question_closed', 'reply', 'verification_request', 'verification_result'].includes(String(v.kind))) throw new Error('Invalid collaboration message kind.');
  const text = textValue(v.text, 'message');
  if (text.length > 12_000) throw new Error('Collaboration message is too long.');
  if (v.kind === 'verification_request') verificationRequest(JSON.parse(text));
  if (v.kind === 'verification_result') verificationResult(JSON.parse(text));
  return { id: identifier(v.id), kind: v.kind as CollaborationMessage['kind'], from: identifier(v.from), to: identifier(v.to),
    ...(v.roomId === undefined ? {} : { roomId: identifier(v.roomId) }), taskId: identifier(v.taskId), questionId: identifier(v.questionId), text };
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid collaboration list.');
  return value;
}
export function peers(value: unknown): Peer[] {
  return array(value).map(item => {
    const v = record(item);
    return { id: identifier(v.id), name: textValue(v.name, 'peer name').slice(0, 200), role: textValue(v.role, 'peer role').slice(0, 100) };
  });
}
export function collaborationState(value: unknown): CollaborationState {
  const v = record(value);
  return { rooms: roomRoster(v.rooms), peers: peers(v.peers), outgoing: array(v.outgoing).map(message), incoming: array(v.incoming).map(message),
    acknowledged: array(v.acknowledged).map(identifier), consumed: array(v.consumed).map(identifier) };
}

export function roomRoster(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(record(value)).map(([id, members]) => [identifier(id), array(members).map(identifier)]));
}
