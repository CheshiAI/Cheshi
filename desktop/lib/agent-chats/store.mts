import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseChatsSnapshot, parseRoomJob, type AgentRoom, type ChatsSnapshot, type RoomJob, type RoomMessage } from '../../shared/agent-chats.ts';
import { agentRecord } from '../../shared/agent-management.ts';
interface State { version: 1; rooms: AgentRoom[]; messages: RoomMessage[]; jobs: RoomJob[] }
function parseSavedState(value: unknown): State {
  const v = agentRecord(value);
  if (v.version !== 1 || !Array.isArray(v.rooms) || !Array.isArray(v.messages) || !Array.isArray(v.jobs)) throw new Error('Invalid Chats journal.');
  const snapshot = parseChatsSnapshot(v);
  const state: State = { version: 1, ...snapshot, jobs: v.jobs.map(parseRoomJob) };
  for (const records of [state.rooms, state.messages, state.jobs]) {
    if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('Duplicate Chats identity.');
  }
  for (const m of state.messages) {
    const room = state.rooms.find(r => r.id === m.roomId);
    if (!room || (m.sender !== 'user' && !room.members.some(p => p.id === m.sender))
      || (m.recipient !== null && !room.members.some(p => p.id === m.recipient))) throw new Error('Invalid saved participant.');
    if (m.threadId && !state.messages.some(root => root.id === m.threadId && root.roomId === room.id && (root.kind === 'goal' || (root.sender === 'user' && root.dialogue)) && root.threadId === null)) throw new Error('Invalid saved goal thread.');
  }
  for (const j of state.jobs) {
    const message = state.messages.find(m => m.id === j.id);
    if (!message || message.sender !== 'user' || message.roomId !== j.roomId || message.recipient !== j.agentId || message.taskId !== j.taskId
      || j.goal !== (message.kind === 'goal') || j.threadId !== (j.goal ? j.id : message.threadId) || (j.inputId && j.inputId !== j.id)) throw new Error('Invalid saved delivery identity.');
  }
  return state;
}
/** Single host owner. Persist the outbox before dispatching or acknowledging a user message. */
export class ChatsStore {
  private readonly filename: string;
  private state: State;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  constructor(filename: string) {
    this.filename = filename;
    try {
      this.state = parseSavedState(JSON.parse(readFileSync(filename, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, rooms: [], messages: [], jobs: [] };
    }
    this.update(s => { for (const j of s.jobs) if (j.state === 'sending') { j.state = 'unknown'; j.error = 'Delivery interrupted. Checking the saved worker task.'; } });
  }
  update(mutator: (state: State) => void): void {
    const next = structuredClone(this.state); mutator(next);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('Chats storage limit reached.');
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.filename}.tmp`, json, { mode: 0o600, flush: true });
    renameSync(`${this.filename}.tmp`, this.filename); this.state = next;
    for (const listener of this.listeners) listener();
  }
  all(): State { return structuredClone(this.state); }
  snapshot(workspace: string): ChatsSnapshot {
    const rooms = this.state.rooms.filter(r => r.workspace === workspace);
    return structuredClone({ rooms, messages: this.state.messages.filter(m => rooms.some(r => r.id === m.roomId)) });
  }
}
