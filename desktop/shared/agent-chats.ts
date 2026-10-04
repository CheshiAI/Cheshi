import { parseConversation, type ConversationState } from '../../experiments/codex-specialists/src/conversation-contract.ts';
import type { WorkKind } from './agent-work.ts';
import { isWorkKind, parseIntegration, type IntegrationSummary } from './agent-work.ts';
import { agentRecord, agentText, parseAgentEngineId, parseAgentId, parseExecutionRecovery, type ExecutionRecovery } from './agent-management.ts';
import { parseQuestionDeadline } from './agent-question.ts';

import { parseGoalUsage, type TaskGoalUsage } from './agent-task-inspection.ts';

export const AGENT_CHATS_CHANNEL = 'cheshi:agent-chats:request';
export interface RoomQuestion { id: string; recipient: string; text: string; status: 'waiting' | 'answered' | 'closed' | 'expired'; closure: string | null; expiresAt?: string | null }
export interface RoomGoalProgress {
  integration?: IntegrationSummary;
  questions?: RoomQuestion[];
  recovery?: ExecutionRecovery;
  phase: string; progress: string; reason: string; nextAction: string;
  usage?: TaskGoalUsage;
  turns: number | null; resumeBlocked: string | null;
}
export interface ChatMember { id: string; accountId: string; name: string }
export interface AgentRoom {
  id: string; workspace: string; name: string; engineId: string; members: ChatMember[]; defaultAgentId: string; createdAt: string;
}
export interface RoomMessage {
  dialogue?: ConversationState;
  id: string; roomId: string; threadId: string | null; sender: string; recipient: string | null;
  kind: WorkKind | 'message' | 'goal' | 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result';
  text: string; createdAt: string; taskId?: string; status?: string; error?: string | null;
  relatedTask?: { agentId: string; taskId: string };
  goalProgress?: RoomGoalProgress;
}
export interface RoomJob {
  id: string; roomId: string; threadId: string | null; agentId: string; taskId: string; prompt: string;
  automatic?: true; userText?: string; questionId?: string; answerTo?: string;
  goal: boolean; inputId?: string; state: 'queued' | 'sending' | 'sent' | 'unknown' | 'held'; error: string | null;
}
export interface ChatsSnapshot { rooms: AgentRoom[]; messages: RoomMessage[] }
export interface ChatTaskTarget { roomId: string; threadId: string | null; agentId: string; engineId: string; taskId: string }
export type ChatsRequest = { action: 'list' }
  | { action: 'question-deadline'; roomId: string; goalId: string; questionId: string; expiresAt: string | null }
  | { action: 'question'; roomId: string; goalId: string; questionId: string; recipient: string | null }
  | { action: 'application-inspect'; roomId: string; goalId: string; candidateId: string; hash: string }
  | { action: 'recover'; roomId: string; goalId: string }
  | { action: 'create'; id: string; name: string; engineId: string; members: string[]; defaultAgentId: string }
  | { action: 'invite'; roomId: string; members: string[]; defaultAgentId: string }
  | { action: 'send'; id: string; roomId: string; threadId: string | null; recipient: string | null; text: string; goal: boolean; automatic?: true; questionId?: string; answerTo?: string };
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
  if (v.action === 'question-deadline') return { action: 'question-deadline', roomId: chatId(v.roomId), goalId: chatId(v.goalId), questionId: chatId(v.questionId), expiresAt: parseQuestionDeadline(v.expiresAt) };
  if (v.action === 'question') return { action: 'question', roomId: chatId(v.roomId), goalId: chatId(v.goalId), questionId: chatId(v.questionId), recipient: v.recipient === null ? null : chatId(v.recipient) };
  if (v.action === 'application-inspect') {
    if (![v.candidateId, v.hash].every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid application identity.');
    return { action: 'application-inspect', roomId: chatId(v.roomId), goalId: chatId(v.goalId), candidateId: v.candidateId as string, hash: v.hash as string };
  }
  if (v.action === 'recover') return { action: 'recover', roomId: chatId(v.roomId), goalId: chatId(v.goalId) };
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
    recipient: v.recipient === null ? null : chatId(v.recipient), text: required(v.text, 16_000), goal: v.goal,
    ...conversationDelivery(v) };
}

function conversationDelivery(v: Record<string, unknown>) {
  if (v.automatic !== undefined && v.automatic !== true) throw new Error('Invalid automatic mode.');
  if ((v.questionId === undefined) !== (v.answerTo === undefined)) throw new Error('An answer must identify its question.');
  return { ...(v.automatic === true ? { automatic: true as const } : {}),
    ...(v.questionId === undefined ? {} : { questionId: chatId(v.questionId), answerTo: chatId(v.answerTo) }) };
}
function entries<T>(value: unknown, parse: (value: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid Chats list.');
  return value.map(parse);
}
function optionalId(value: unknown): string | null { return value === null ? null : chatId(value); }
function parseGoalProgress(value: unknown): RoomGoalProgress {
  const v = agentRecord(value);
  if (v.turns !== null && (!Number.isSafeInteger(v.turns) || Number(v.turns) < 0)) throw new Error('Invalid goal turns.');
  return { ...(v.questions === undefined ? {} : { questions: entries(v.questions, raw => {
    const q = agentRecord(raw);
    if (!['waiting', 'answered', 'closed', 'expired'].includes(String(q.status))) throw new Error('Invalid question status.');
    return { id: chatId(q.id), recipient: chatId(q.recipient), text: required(q.text, 12000), status: q.status as RoomQuestion['status'], closure: q.closure === null ? null : required(q.closure, 12000),
      ...(q.expiresAt === undefined ? {} : { expiresAt: parseQuestionDeadline(q.expiresAt) }) };
  }, 16) }), ...(v.recovery === undefined ? {} : { recovery: parseExecutionRecovery(v.recovery) }), phase: required(v.phase, 100), progress: agentText(v.progress, 4000), reason: agentText(v.reason, 20_000),
    nextAction: agentText(v.nextAction, 4000), turns: v.turns as number | null,
    ...(v.usage === undefined ? {} : { usage: parseGoalUsage(v.usage) }),
    ...(v.integration === undefined ? {} : { integration: parseIntegration(v.integration) }),
    resumeBlocked: v.resumeBlocked === null ? null : required(v.resumeBlocked, 20_000) };
}
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
  if (!isWorkKind(v.kind) && !['message', 'goal', 'question', 'question_closed', 'reply', 'verification_request', 'verification_result'].includes(String(v.kind))) throw new Error('Invalid room message.');
  return { ...(v.dialogue === undefined ? {} : { dialogue: parseConversation(v.dialogue) }), id: chatId(v.id), roomId: chatId(v.roomId), threadId: optionalId(v.threadId), sender: chatId(v.sender), recipient: optionalId(v.recipient),
    kind: v.kind as RoomMessage['kind'], text: agentText(v.text, 500_000), createdAt: required(v.createdAt, 100),
    ...(v.relatedTask === undefined ? {} : { relatedTask: (() => { const t = agentRecord(v.relatedTask); return { agentId: chatId(t.agentId), taskId: chatId(t.taskId) }; })() }),
    ...(v.taskId === undefined ? {} : { taskId: chatId(v.taskId) }), ...(v.status === undefined ? {} : { status: required(v.status, 100) }),
    ...(v.error === undefined ? {} : { error: v.error === null ? null : agentText(v.error, 20_000) }),
    ...(v.goalProgress === undefined ? {} : { goalProgress: parseGoalProgress(v.goalProgress) }) };
}
export function parseRoomJob(value: unknown): RoomJob {
  const v = agentRecord(value);
  if (typeof v.goal !== 'boolean' || !['queued', 'sending', 'sent', 'unknown', 'held'].includes(String(v.state))) throw new Error('Invalid saved room delivery.');
  return { id: chatId(v.id), roomId: chatId(v.roomId), threadId: optionalId(v.threadId), agentId: chatId(v.agentId), taskId: chatId(v.taskId),
    ...conversationDelivery(v), ...(v.userText === undefined ? {} : { userText: required(v.userText, 16000) }),
    prompt: required(v.prompt, 20_000), goal: v.goal, state: v.state as RoomJob['state'], error: v.error === null ? null : agentText(v.error, 20_000),
    ...(v.inputId === undefined ? {} : { inputId: chatId(v.inputId) }) };
}
export function parseChatsSnapshot(value: unknown): ChatsSnapshot {
  const v = agentRecord(value);
  return { rooms: entries(v.rooms, parseRoom, 1000), messages: entries(v.messages, parseRoomMessage, 100_000) };
}
