import { parseIsolatedWork, parseIsolatedWorkSpec, type IsolatedWork, type IsolatedWorkSpec } from './isolated-work.ts';
import { localFileLinkPath } from './local-file-link.ts';
import { parsePermissionRequest, type PermissionRequest } from '../../experiments/codex-specialists/src/execution-permissions.ts';
import { parseTaskActivity, type TaskActivity } from './agent-activity.ts';
import { parseTaskInspection, type TaskInspection } from './agent-task-inspection.ts';
import { parseWorkerLifecycle, type AgentRuntimeState } from './agent-runtime.ts';
import { parseConversation, type ConversationState } from '../../experiments/codex-specialists/src/conversation-contract.ts';
import type { WorkKind } from './agent-work.ts';
import { isWorkKind, parseIntegration, type IntegrationSummary } from './agent-work.ts';
import { agentRecord, agentText, parseAgentEngineId, parseAgentId, parseExecutionRecovery, type ExecutionRecovery } from './agent-management.ts';
import { parseQuestionDeadline } from './agent-question.ts';
import { parseWorkerWorkspaceInspection, type WorkerWorkspaceInspection } from './worker-workspace.ts';

import { parseGoalUsage, type TaskGoalUsage } from './agent-task-inspection.ts';

export const AGENT_CHATS_CHANGED = 'cheshi:agent-chats:changed';
export interface ChatsCursor { epoch: string; sequence: number }
export interface ChatsUpdate { cursor: ChatsCursor; rooms: AgentRoom[]; messages: RoomMessage[]; removedRoomIds: string[]; removedMessageIds: string[] }
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
  formerMembers?: ChatMember[];
  pinned?: boolean;
  id: string; workspace: string; name: string; engineId: string; members: ChatMember[]; defaultAgentId: string; createdAt: string;
}
export interface RoomMessage {
  workspaceInspection?: WorkerWorkspaceInspection;
  isolated?: IsolatedWork;
  permissionRequest?: PermissionRequest;
  replyTo?: string; userQuestion?: { rootId: string; id: string; answered: boolean };
  activity?: TaskActivity; inspection?: TaskInspection; executionStatus?: string; questionId?: string;
  worker?: AgentRuntimeState['lifecycle'];
  dialogue?: ConversationState;
  id: string; roomId: string; threadId: string | null; sender: string; recipient: string | null;
  kind: WorkKind | 'permission_request' | 'message' | 'goal' | 'question' | 'question_closed' | 'reply' | 'verification_request' | 'verification_result';
  text: string; createdAt: string; taskId?: string; status?: string; error?: string | null;
  relatedTask?: { agentId: string; taskId: string };
  goalProgress?: RoomGoalProgress;
}
export interface RoomJob {
  id: string; roomId: string; threadId: string | null; agentId: string; taskId: string; prompt: string;
  automatic?: true; userText?: string; questionId?: string; answerTo?: string;
  goal: boolean; inputId?: string; state: 'queued' | 'sending' | 'sent' | 'unknown' | 'held'; error: string | null;
}
export interface ChatsSnapshot { cursor?: ChatsCursor; rooms: AgentRoom[]; messages: RoomMessage[] }
export interface ChatTaskTarget { roomId: string; threadId: string | null; agentId: string; engineId: string; taskId: string }
export function isRoomWorkSettled(status: string | undefined): boolean {
  return ['completed', 'failed', 'interrupted', 'paused', 'blocked', 'held', 'cancelled'].includes(status ?? '');
}
export type ChatsRequest = { action: 'list' }
  | { action: 'workspace-inspect' | 'workspace-open'; roomId: string; messageId: string }
  | { action: 'open-file'; roomId: string; messageId: string; href: string }
  | ({ action: 'isolated-submit'; id: string; roomId: string; agentId: string; prompt: string } & IsolatedWorkSpec)
  | { action: 'isolated-inspect' | 'isolated-cancel'; roomId: string; messageId: string }
  | { action: 'isolated-setup'; roomId: string }
  | { action: 'delete'; roomId: string }
  | { action: 'project-setup'; roomId: string }
  | { action: 'permission'; roomId: string; messageId: string; decision: 'allow' | 'deny' }
  | { action: 'pin'; roomId: string; pinned: boolean }
  | { action: 'retry'; roomId: string; messageId: string }
  | { action: 'question-deadline'; roomId: string; goalId: string; questionId: string; expiresAt: string | null }
  | { action: 'question'; roomId: string; goalId: string; questionId: string; recipient: string | null }
  | { action: 'application-inspect'; roomId: string; goalId: string; candidateId: string; hash: string }
  | { action: 'recover'; roomId: string; goalId: string }
  | { action: 'create'; id: string; name: string; engineId: string; members: string[]; defaultAgentId: string }
  | { action: 'participants'; roomId: string; members: string[]; defaultAgentId: string; expectedMembers: string[]; expectedDefaultAgentId: string }
  | { action: 'invite'; roomId: string; members: string[]; defaultAgentId: string }
  | { action: 'send'; id: string; roomId: string; threadId: string | null; recipient: string | null; text: string; goal: boolean; automatic?: true; questionId?: string; answerTo?: string; replyTo?: string };
export interface AgentChatsApi { request(input: ChatsRequest): Promise<ChatsSnapshot>; onDidChange?(listener: (update: ChatsUpdate) => void): () => void }
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
  if (v.action === 'workspace-inspect' || v.action === 'workspace-open') return { action: v.action, roomId: chatId(v.roomId), messageId: chatId(v.messageId) };
  if (v.action === 'open-file') {
    if (!localFileLinkPath(v.href)) throw new Error('Invalid Worker file link.');
    return { action: 'open-file', roomId: chatId(v.roomId), messageId: chatId(v.messageId), href: v.href as string };
  }
  if (v.action === 'isolated-submit') return { action: 'isolated-submit', id: chatId(v.id), roomId: chatId(v.roomId), agentId: chatId(v.agentId), prompt: required(v.prompt, 4000), ...parseIsolatedWorkSpec(v) };
  if (v.action === 'isolated-inspect' || v.action === 'isolated-cancel') return { action: v.action, roomId: chatId(v.roomId), messageId: chatId(v.messageId) };
  if (v.action === 'isolated-setup') return { action: 'isolated-setup', roomId: chatId(v.roomId) };
  if (v.action === 'delete') return { action: 'delete', roomId: chatId(v.roomId) };
  if (v.action === 'project-setup') return { action: 'project-setup', roomId: chatId(v.roomId) };
  if (v.action === 'permission') {
    if (v.decision !== 'allow' && v.decision !== 'deny') throw new Error('Invalid permission decision.');
    return { action: 'permission', roomId: chatId(v.roomId), messageId: chatId(v.messageId), decision: v.decision };
  }
  if (v.action === 'pin') {
    if (typeof v.pinned !== 'boolean') throw new Error('Invalid room pin state.');
    return { action: 'pin', roomId: chatId(v.roomId), pinned: v.pinned };
  }
  if (v.action === 'retry') return { action: 'retry', roomId: chatId(v.roomId), messageId: chatId(v.messageId) };
  if (v.action === 'question-deadline') return { action: 'question-deadline', roomId: chatId(v.roomId), goalId: chatId(v.goalId), questionId: chatId(v.questionId), expiresAt: parseQuestionDeadline(v.expiresAt) };
  if (v.action === 'question') return { action: 'question', roomId: chatId(v.roomId), goalId: chatId(v.goalId), questionId: chatId(v.questionId), recipient: v.recipient === null ? null : chatId(v.recipient) };
  if (v.action === 'application-inspect') {
    if (![v.candidateId, v.hash].every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid application identity.');
    return { action: 'application-inspect', roomId: chatId(v.roomId), goalId: chatId(v.goalId), candidateId: v.candidateId as string, hash: v.hash as string };
  }
  if (v.action === 'recover') return { action: 'recover', roomId: chatId(v.roomId), goalId: chatId(v.goalId) };
  if (v.action === 'list') return { action: 'list' };
  if (v.action === 'create' || v.action === 'invite' || v.action === 'participants') {
    if (!Array.isArray(v.members) || !v.members.length || v.members.length > 32) throw new Error('Choose 1–32 agents.');
    const members = [...new Set(v.members.map(chatId))], defaultAgentId = chatId(v.defaultAgentId);
    if (!members.includes(defaultAgentId)) throw new Error('The default agent must participate in the room.');
    if (v.action === 'participants') {
      if (!Array.isArray(v.expectedMembers) || !v.expectedMembers.length || v.expectedMembers.length > 32) throw new Error('Invalid previous participants.');
      return { action: 'participants', roomId: chatId(v.roomId), members, defaultAgentId,
        expectedMembers: v.expectedMembers.map(chatId), expectedDefaultAgentId: chatId(v.expectedDefaultAgentId) };
    }
    return v.action === 'create' ? { action: 'create', id: chatId(v.id), name: required(v.name, 100), engineId: parseAgentEngineId(v.engineId), members, defaultAgentId }
      : { action: 'invite', roomId: chatId(v.roomId), members, defaultAgentId };
  }
  if (v.action !== 'send' || typeof v.goal !== 'boolean') throw new Error('Invalid chat request.');
  return { action: 'send', id: chatId(v.id), roomId: chatId(v.roomId), threadId: v.threadId === null ? null : chatId(v.threadId),
    recipient: v.recipient === null ? null : chatId(v.recipient), text: required(v.text, 16_000), goal: v.goal,
    ...conversationDelivery(v), ...(v.replyTo === undefined ? {} : { replyTo: chatId(v.replyTo) }) };
}

function conversationDelivery(v: Record<string, unknown>) {
  if (v.automatic !== undefined && v.automatic !== true) throw new Error('Invalid automatic mode.');
  if ((v.questionId === undefined) !== (v.answerTo === undefined)) throw new Error('An answer must identify its question.');
  return { ...(v.automatic === true ? { automatic: true as const } : {}),
    ...(v.questionId === undefined ? {} : { questionId: chatId(v.questionId), answerTo: chatId(v.answerTo) }) };
}
function entries<T>(value: unknown, parse: (value: unknown) => T, max = Number.POSITIVE_INFINITY): T[] {
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
  const v = agentRecord(value);
  const member = (raw: unknown): ChatMember => {
    const m = agentRecord(raw); return { id: chatId(m.id), name: required(m.name, 100), accountId: required(m.accountId, 200) };
  };
  const members = entries(v.members, member, 32);
  const formerMembers = v.formerMembers === undefined ? [] : entries(v.formerMembers, member);
  const identities = [...members, ...formerMembers];
  if (new Set(identities.map(item => item.id)).size !== identities.length) throw new Error('Duplicate room identity.');
  if (v.pinned !== undefined && typeof v.pinned !== 'boolean') throw new Error('Invalid room pin state.');
  const defaultAgentId = chatId(v.defaultAgentId);
  if (!members.some(m => m.id === defaultAgentId) || new Set(members.map(m => m.id)).size !== members.length) throw new Error('Invalid room membership.');
  return { id: chatId(v.id), workspace: required(v.workspace, 4096), name: required(v.name, 100), engineId: parseAgentEngineId(v.engineId),
    members, ...(formerMembers.length ? { formerMembers } : {}), defaultAgentId, createdAt: required(v.createdAt, 100), pinned: v.pinned === true };
}
export function parseRoomMessage(value: unknown): RoomMessage {
  const v = agentRecord(value);
  if (!isWorkKind(v.kind) && !['permission_request', 'message', 'goal', 'question', 'question_closed', 'reply', 'verification_request', 'verification_result'].includes(String(v.kind))) throw new Error('Invalid room message.');
  const userQuestion = v.userQuestion === undefined ? undefined : agentRecord(v.userQuestion);
  if (userQuestion && typeof userQuestion.answered !== 'boolean') throw new Error('Invalid user question state.');
  return { ...(v.isolated === undefined ? {} : { isolated: parseIsolatedWork(v.isolated) }), ...(v.permissionRequest === undefined ? {} : { permissionRequest: parsePermissionRequest(v.permissionRequest) }), ...(v.replyTo === undefined ? {} : { replyTo: chatId(v.replyTo) }),
    ...(userQuestion ? { userQuestion: { rootId: chatId(userQuestion.rootId), id: chatId(userQuestion.id), answered: userQuestion.answered as boolean } } : {}),
    ...(v.activity === undefined ? {} : { activity: parseTaskActivity(v.activity) }),
    ...(v.inspection === undefined ? {} : { inspection: parseTaskInspection(v.inspection) }),
    ...(v.workspaceInspection === undefined ? {} : { workspaceInspection: parseWorkerWorkspaceInspection(v.workspaceInspection) }),
    ...(v.executionStatus === undefined ? {} : { executionStatus: required(v.executionStatus, 100) }),
    ...(v.questionId === undefined ? {} : { questionId: chatId(v.questionId) }), ...(v.worker === undefined ? {} : { worker: parseWorkerLifecycle(v.worker) }), ...(v.dialogue === undefined ? {} : { dialogue: parseConversation(v.dialogue) }), id: chatId(v.id), roomId: chatId(v.roomId), threadId: optionalId(v.threadId), sender: chatId(v.sender), recipient: optionalId(v.recipient),
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
  return { ...(v.cursor === undefined ? {} : { cursor: parseChatsCursor(v.cursor) }), rooms: entries(v.rooms, parseRoom, 1000), messages: entries(v.messages, parseRoomMessage, 100_000) };
}

function parseChatsCursor(value: unknown): ChatsCursor {
  const v = agentRecord(value);
  if (typeof v.epoch !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(v.epoch) || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 0) throw new Error('Invalid Chats event cursor.');
  return { epoch: v.epoch, sequence: Number(v.sequence) };
}
export function parseChatsUpdate(value: unknown): ChatsUpdate {
  const v = agentRecord(value), snapshot = parseChatsSnapshot(value);
  return { ...snapshot, cursor: parseChatsCursor(v.cursor), removedRoomIds: entries(v.removedRoomIds, chatId, 1000), removedMessageIds: entries(v.removedMessageIds, chatId, 100_000) };
}
