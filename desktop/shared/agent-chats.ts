import { agentRecord, agentText, parseAgentEngineId, parseAgentId } from './agent-management.ts';

export const AGENT_CHATS_CHANNEL = 'cheshi:agent-chats:request';
export interface ChatMember { id: string; accountId: string; name: string }
export interface AgentRoom {
  id: string; workspace: string; name: string; engineId: string; members: ChatMember[]; defaultAgentId: string; createdAt: string;
}
export interface RoomMessage {
  id: string; roomId: string; threadId: string | null; sender: string; recipient: string | null;
  kind: 'message' | 'goal' | 'question' | 'reply' | 'verification_request' | 'verification_result';
  text: string; createdAt: string; taskId?: string; status?: string; error?: string | null;
}
export interface RoomJob {
  id: string; roomId: string; threadId: string | null; agentId: string; taskId: string; prompt: string;
  goal: boolean; inputId?: string; state: 'queued' | 'sending' | 'sent' | 'unknown'; error: string | null;
}
export interface ChatsSnapshot { rooms: AgentRoom[]; messages: RoomMessage[] }
export interface ChatTaskTarget { roomId: string; threadId: string | null; agentId: string; engineId: string; taskId: string }
export type ChatsRequest = { action: 'list' }
  | { action: 'create'; id: string; name: string; engineId: string; members: string[]; defaultAgentId: string }
  | { action: 'invite'; roomId: string; members: string[]; defaultAgentId: string }
  | { action: 'send'; id: string; roomId: string; threadId: string | null; recipient: string | null; text: string; goal: boolean };
export interface AgentChatsApi { request(input: ChatsRequest): Promise<ChatsSnapshot> }
export const chatId = (value: unknown): string => {
  const id = parseAgentId(value);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid chat identifier.');
  return id;
};
function required(value: unknown, max: number): string {
  const text = agentText(value, max).trim();
  if (!text || text.includes('\0')) throw new Error('Enter a name or message.');
  return text;
}
export function parseChatsRequest(value: unknown): ChatsRequest {
  const v = agentRecord(value);
  if (v.action === 'list') return { action: 'list' };
  if (v.action === 'create' || v.action === 'invite') {
    if (!Array.isArray(v.members) || !v.members.length || v.members.length > 32) throw new Error('Choose 1–32 agents.');
    const members = [...new Set(v.members.map(chatId))], defaultAgentId = chatId(v.defaultAgentId);
    if (!members.includes(defaultAgentId)) throw new Error('The default agent must participate in the room.');
    return v.action === 'create' ? { action: 'create', id: chatId(v.id), name: required(v.name, 100), engineId: parseAgentEngineId(v.engineId), members, defaultAgentId }
      : { action: 'invite', roomId: chatId(v.roomId), members, defaultAgentId };
  }
  if (v.action !== 'send' || typeof v.goal !== 'boolean') throw new Error('Invalid chat request.');
  return { action: 'send', id: chatId(v.id), roomId: chatId(v.roomId), threadId: v.threadId === null ? null : chatId(v.threadId),
    recipient: v.recipient === null ? null : chatId(v.recipient), text: required(v.text, 16_000), goal: v.goal };
}

function entries<T>(value: unknown, parse: (value: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid Chats list.');
  return value.map(parse);
}
function optionalId(value: unknown): string | null { return value === null ? null : chatId(value); }
export function parseRoom(value: unknown): AgentRoom {
  const v = agentRecord(value), members = entries(v.members, raw => {
    const m = agentRecord(raw); return { id: chatId(m.id), name: required(m.name, 100), accountId: required(m.accountId, 200) };
  }, 32);
  const defaultAgentId = chatId(v.defaultAgentId);
  if (!members.some(m => m.id === defaultAgentId) || new Set(members.map(m => m.id)).size !== members.length) throw new Error('Invalid room membership.');
  return { id: chatId(v.id), workspace: required(v.workspace, 4096), name: required(v.name, 100), engineId: parseAgentEngineId(v.engineId),
    members, defaultAgentId, createdAt: required(v.createdAt, 100) };
}
export function parseRoomMessage(value: unknown): RoomMessage {
  const v = agentRecord(value);
  if (!['message', 'goal', 'question', 'reply', 'verification_request', 'verification_result'].includes(String(v.kind))) throw new Error('Invalid room message.');
  return { id: chatId(v.id), roomId: chatId(v.roomId), threadId: optionalId(v.threadId), sender: chatId(v.sender), recipient: optionalId(v.recipient),
    kind: v.kind as RoomMessage['kind'], text: agentText(v.text, 500_000), createdAt: required(v.createdAt, 100),
    ...(v.taskId === undefined ? {} : { taskId: chatId(v.taskId) }), ...(v.status === undefined ? {} : { status: required(v.status, 100) }),
    ...(v.error === undefined ? {} : { error: v.error === null ? null : agentText(v.error, 20_000) }) };
}
export function parseRoomJob(value: unknown): RoomJob {
  const v = agentRecord(value);
  if (typeof v.goal !== 'boolean' || !['queued', 'sending', 'sent', 'unknown'].includes(String(v.state))) throw new Error('Invalid saved room delivery.');
  return { id: chatId(v.id), roomId: chatId(v.roomId), threadId: optionalId(v.threadId), agentId: chatId(v.agentId), taskId: chatId(v.taskId),
    prompt: required(v.prompt, 20_000), goal: v.goal, state: v.state as RoomJob['state'], error: v.error === null ? null : agentText(v.error, 20_000),
    ...(v.inputId === undefined ? {} : { inputId: chatId(v.inputId) }) };
}
export function parseChatsSnapshot(value: unknown): ChatsSnapshot {
  const v = agentRecord(value);
  return { rooms: entries(v.rooms, parseRoom, 1000), messages: entries(v.messages, parseRoomMessage, 100_000) };
}
