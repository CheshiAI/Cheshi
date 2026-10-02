import { record, textValue } from './protocol.ts';

export interface Peer { id: string; name: string; role: string }
export interface CollaborationMessage {
  id: string; kind: 'question' | 'reply'; from: string; to: string;
  taskId: string; questionId: string; text: string;
}
export interface CollaborationState {
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
  if (v.kind !== 'question' && v.kind !== 'reply') throw new Error('Invalid collaboration message kind.');
  const text = textValue(v.text, 'message');
  if (text.length > 12_000) throw new Error('Collaboration message is too long.');
  return { id: identifier(v.id), kind: v.kind, from: identifier(v.from), to: identifier(v.to),
    taskId: identifier(v.taskId), questionId: identifier(v.questionId), text };
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
  return { peers: peers(v.peers), outgoing: array(v.outgoing).map(message), incoming: array(v.incoming).map(message),
    acknowledged: array(v.acknowledged).map(identifier), consumed: array(v.consumed).map(identifier) };
}
