import { normalizeMcpRuntimeStatus, type ChatMcpRuntimeStatus } from '../../../../shared/chat-mcp-status';
import { normalizeChatAsyncQuestions, type ChatAsyncQuestion } from '../../../../shared/chat-async-question';

export interface ChatSession {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: string;
}

export interface ChatAgentThread {
  id: string;
  parentThreadId: string | null;
  title: string;
  description: string;
  kind: 'main' | 'subagent';
  role: string | null;
  depth: number;
  status: string;
  current: boolean;
}

export interface ChatSkill {
  name: string;
  displayName: string;
  description: string;
  scope: 'user' | 'repo' | 'system' | 'admin';
  path: string;
}

export interface ChatReasoningEffort {
  effort: string;
  description: string;
}

export interface ChatServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface ChatModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ChatReasoningEffort[];
  serviceTiers: ChatServiceTier[];
  defaultServiceTier: string | null;
}

export interface ChatConfiguration {
  collaborationMode?: 'default' | 'plan';
  model: string | null;
  modelDisplayName: string;
  reasoningEffort: string;
  supportedReasoningEfforts: ChatReasoningEffort[];
  serviceTier: string | null;
  serviceTierDisplayName: string;
  fastModeAvailable: boolean;
  fastModeEnabled: boolean;
}

export interface ChatModelCatalog {
  models: ChatModel[];
  configuration: ChatConfiguration;
}

export interface ChatCommandStatus extends ChatConfiguration {
  threadId: string | null;
  access: string;
  responseInProgress: boolean;
}

export interface ChatMcpServer {
  name: string;
  displayName: string;
  version: string | null;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
  authStatus: string;
  connected: boolean;
  runtimeStatus: ChatMcpRuntimeStatus | null;
  toolsError: string | null;
}

export type ChatGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface ChatGoal {
  threadId: string;
  objective: string;
  status: ChatGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

export interface ChatPermissionMode {
  id: string;
  profileId: string;
  label: string;
  description: string;
  access: string;
  allowed: boolean;
  dangerous: boolean;
}

export interface ChatPermissionModesResponse {
  modes: ChatPermissionMode[];
  currentMode: ChatPermissionMode;
}

export type ChatApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

export interface ChatApprovalRequest {
  id: string;
  threadId: string;
  kind: 'command' | 'fileChange' | 'permissions';
  title: string;
  detail: string;
  canAllowForSession: boolean;
}

interface ChatTextItem {
  id: string;
  providerItemId?: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'plan';
  text: string;
  createdAt: number;
  pending?: boolean;
  delivery?: 'failed' | 'unknown';
  questions?: ChatAsyncQuestion[];
}

export type ChatFileChangeKind = 'add' | 'delete' | 'update';

export interface ChatFileChange {
  path: string;
  kind: ChatFileChangeKind;
  diff: string;
  movePath: string | null;
}

export interface ChatActivityItem {
  id: string;
  kind: 'activity';
  activity: string;
  label: string;
  detail: string;
  status: string;
  changes?: ChatFileChange[];
  output?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
}

export type ChatTimelineItem = ChatTextItem | ChatActivityItem;
export type ChatPhase = 'idle' | 'loading' | 'streaming';

export interface ChatState {
  sessions: ChatSession[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  responseThreadIds: string[];
  pendingNewResponse: boolean;
  activeTitle: string;
  items: ChatTimelineItem[];
  phase: ChatPhase;
  error: string | null;
  access: string;
  permissionMode: ChatPermissionMode | null;
  approvals: ChatApprovalRequest[];
}

export const INITIAL_CHAT_STATE: ChatState = {
  sessions: [],
  sessionsLoading: true,
  activeSessionId: null,
  responseThreadIds: [],
  pendingNewResponse: false,
  activeTitle: 'New chat',
  items: [],
  phase: 'idle',
  error: null,
  access: 'Read only',
  permissionMode: null,
  approvals: [],
};

export function isViewedSessionResponding(
  state: Pick<ChatState, 'activeSessionId' | 'responseThreadIds' | 'pendingNewResponse'>,
): boolean {
  return state.activeSessionId === null
    ? state.pendingNewResponse
    : state.responseThreadIds.includes(state.activeSessionId);
}

type ChatEvent =
  | { type: 'session-created'; session: ChatSession }
  | { type: 'session-selected'; threadId: string; previousThreadId?: string | null }
  | { type: 'session-title'; threadId: string; title: string }
  | { type: 'turn-started'; threadId: string }
  | { type: 'user-message'; threadId: string; clientMessageId: string; text: string; createdAt: number }
  | { type: 'user-message-identified'; threadId: string; clientMessageId: string; itemId: string }
  | { type: 'assistant-delta' | 'reasoning-delta' | 'plan-delta' | 'plan-completed'; threadId: string; itemId: string; text: string; createdAt: number }
  | { type: 'assistant-questions'; threadId: string; itemId: string; questions: ChatAsyncQuestion[]; createdAt: number }
  | { type: 'activity'; threadId: string; item: ChatActivityItem }
  | { type: 'command-output-delta'; threadId: string; itemId: string; text: string }
  | { type: 'turn-completed'; threadId: string; status: string; message: string | null }
  | { type: 'permission-mode-changed'; mode: ChatPermissionMode }
  | { type: 'approval-requested'; approval: ChatApprovalRequest }
  | { type: 'approval-resolved'; approvalId: string; threadId: string }
  | { type: 'sessions-changed' }
  | { type: 'sessions-deleted'; threadIds: string[] }
  | { type: 'error'; threadId: string | null; message: string };

export type ChatAction =
  | { type: 'sessions-loaded'; sessions: ChatSession[] }
  | { type: 'sessions-error'; message: string }
  | { type: 'opening-session' }
  | { type: 'opening-session-failed'; message: string }
  | {
    type: 'session-opened';
    session: ChatSession;
    items: ChatTimelineItem[];
    responseInProgress: boolean;
    responseThreadIds: string[];
  }
  | { type: 'new-session' }
  | { type: 'optimistic-user'; id: string; text: string; title: string; createdAt: number }
  | { type: 'send-accepted'; clientMessageId: string }
  | { type: 'message-error'; message: string; threadId?: string | null }
  | { type: 'send-failed'; clientMessageId: string; threadId: string | null; message: string; uncertain?: boolean; steering?: boolean }
  | { type: 'operation-error'; message: string }
  | { type: 'dismiss-error' }
  | { type: 'events'; events: ChatEvent[] }
  | { type: 'event'; event: ChatEvent };

function recordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSession(value: unknown): ChatSession | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const title = stringValue(record?.title);
  if (!record || !id || !title) return null;
  return {
    id,
    title,
    preview: stringValue(record.preview) ?? '',
    createdAt: finiteNumber(record.createdAt) ?? 0,
    updatedAt: finiteNumber(record.updatedAt) ?? 0,
    status: stringValue(record.status) ?? 'notLoaded',
  };
}

function normalizeAgentThread(value: unknown): ChatAgentThread | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const parentThreadId = record?.parentThreadId === null ? null : stringValue(record?.parentThreadId);
  const title = stringValue(record?.title);
  const kind = stringValue(record?.kind);
  const role = record?.role === null ? null : stringValue(record?.role);
  const depth = finiteNumber(record?.depth);
  const status = stringValue(record?.status);
  const current = record?.current;
  if (
    !record
    || !id
    || (record.parentThreadId !== null && !parentThreadId)
    || !title
    || (kind !== 'main' && kind !== 'subagent')
    || (record.role !== null && !role)
    || depth === null
    || !Number.isInteger(depth)
    || depth < 0
    || !status
    || (current !== true && current !== false)
  ) return null;
  return {
    id,
    parentThreadId,
    title,
    description: typeof record.description === 'string' ? record.description : '',
    kind,
    role,
    depth,
    status,
    current,
  };
}

function normalizeSkill(value: unknown): ChatSkill | null {
  const record = recordValue(value);
  const name = stringValue(record?.name);
  const displayName = stringValue(record?.displayName);
  const scope = stringValue(record?.scope);
  const path = stringValue(record?.path);
  if (
    !record
    || !name
    || !displayName
    || !path
    || (scope !== 'user' && scope !== 'repo' && scope !== 'system' && scope !== 'admin')
  ) return null;
  return {
    name,
    displayName,
    description: typeof record.description === 'string' ? record.description : '',
    scope,
    path,
  };
}

function normalizeReasoningEffort(value: unknown): ChatReasoningEffort | null {
  const record = recordValue(value);
  const effort = stringValue(record?.effort);
  if (!record || !effort) return null;
  return {
    effort,
    description: stringValue(record.description) ?? effort,
  };
}

function normalizeServiceTier(value: unknown): ChatServiceTier | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const name = stringValue(record?.name);
  if (!record || !id || !name) return null;
  return {
    id,
    name,
    description: stringValue(record.description) ?? name,
  };
}

function normalizeModel(value: unknown): ChatModel | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const model = stringValue(record?.model);
  const displayName = stringValue(record?.displayName);
  const defaultReasoningEffort = stringValue(record?.defaultReasoningEffort);
  const defaultServiceTier = record?.defaultServiceTier === null ? null : stringValue(record?.defaultServiceTier);
  if (!record || !id || !model || !displayName || !defaultReasoningEffort || typeof record.isDefault !== 'boolean') {
    return null;
  }
  if (record.defaultServiceTier !== null && !defaultServiceTier) return null;
  return {
    id,
    model,
    displayName,
    description: stringValue(record.description) ?? model,
    isDefault: record.isDefault,
    defaultReasoningEffort,
    supportedReasoningEfforts: Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts
          .map(normalizeReasoningEffort)
          .filter((option): option is ChatReasoningEffort => option !== null)
      : [],
    serviceTiers: Array.isArray(record.serviceTiers)
      ? record.serviceTiers
          .map(normalizeServiceTier)
          .filter((tier): tier is ChatServiceTier => tier !== null)
      : [],
    defaultServiceTier,
  };
}

function normalizeMcpServer(value: unknown): ChatMcpServer | null {
  const record = recordValue(value);
  const name = stringValue(record?.name);
  const displayName = stringValue(record?.displayName);
  const version = record?.version === null ? null : stringValue(record?.version);
  const toolCount = finiteNumber(record?.toolCount);
  const resourceCount = finiteNumber(record?.resourceCount);
  const resourceTemplateCount = finiteNumber(record?.resourceTemplateCount);
  const authStatus = stringValue(record?.authStatus);
  const connected = record?.connected;
  if (
    !record
    || !name
    || !displayName
    || (record.version !== null && !version)
    || toolCount === null
    || resourceCount === null
    || resourceTemplateCount === null
    || !authStatus
    || (connected !== true && connected !== false)
  ) return null;
  const runtimeStatus = record.runtimeStatus === undefined
    ? (connected === true ? 'connected' : null)
    : normalizeMcpRuntimeStatus(record.runtimeStatus);
  return {
    name,
    displayName,
    version,
    toolCount,
    resourceCount,
    resourceTemplateCount,
    authStatus,
    connected: runtimeStatus === 'connected',
    runtimeStatus,
    toolsError: stringValue(record.toolsError),
  };
}

function normalizeGoal(value: unknown): ChatGoal | null {
  const record = recordValue(value);
  const threadId = stringValue(record?.threadId);
  const objective = stringValue(record?.objective);
  const status = stringValue(record?.status);
  const tokenBudget = record?.tokenBudget === null ? null : finiteNumber(record?.tokenBudget);
  const tokensUsed = finiteNumber(record?.tokensUsed);
  const timeUsedSeconds = finiteNumber(record?.timeUsedSeconds);
  if (
    !record
    || !threadId
    || !objective
    || (
      status !== 'active'
      && status !== 'paused'
      && status !== 'blocked'
      && status !== 'usageLimited'
      && status !== 'budgetLimited'
      && status !== 'complete'
    )
    || (record.tokenBudget !== null && tokenBudget === null)
    || tokensUsed === null
    || timeUsedSeconds === null
  ) return null;
  return { threadId, objective, status, tokenBudget, tokensUsed, timeUsedSeconds };
}

function normalizePermissionMode(value: unknown): ChatPermissionMode | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const profileId = stringValue(record?.profileId);
  const label = stringValue(record?.label);
  const description = stringValue(record?.description);
  const access = stringValue(record?.access);
  const allowed = record?.allowed;
  const dangerous = record?.dangerous;
  if (
    !record
    || !id
    || !profileId
    || !label
    || !description
    || !access
    || (allowed !== true && allowed !== false)
    || (dangerous !== true && dangerous !== false)
  ) return null;
  return { id, profileId, label, description, access, allowed, dangerous };
}

function normalizeApprovalRequest(value: unknown): ChatApprovalRequest | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const threadId = stringValue(record?.threadId);
  const kind = stringValue(record?.kind);
  const title = stringValue(record?.title);
  const detail = stringValue(record?.detail);
  const canAllowForSession = record?.canAllowForSession;
  if (
    !record
    || !id
    || !threadId
    || (kind !== 'command' && kind !== 'fileChange' && kind !== 'permissions')
    || !title
    || !detail
    || (canAllowForSession !== true && canAllowForSession !== false)
  ) return null;
  return { id, threadId, kind, title, detail, canAllowForSession };
}

function normalizeFileChange(value: unknown): ChatFileChange | null {
  const record = recordValue(value);
  const path = stringValue(record?.path);
  const kind = stringValue(record?.kind);
  if (!record || !path || (kind !== 'add' && kind !== 'delete' && kind !== 'update')) return null;
  return {
    path,
    kind,
    diff: typeof record.diff === 'string' ? record.diff : '',
    movePath: stringValue(record.movePath),
  };
}

function normalizeTimelineItem(value: unknown): ChatTimelineItem | null {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const kind = stringValue(record?.kind);
  if (!record || !id || !kind) return null;
  if (kind === 'user' || kind === 'assistant' || kind === 'reasoning' || kind === 'plan') {
    const text = stringValue(record.text);
    const questions = kind === 'assistant' ? normalizeChatAsyncQuestions(record.questions) : [];
    return text || questions.length > 0
      ? { id, kind, text: text ?? '', createdAt: finiteNumber(record.createdAt) ?? 0,
          ...(questions.length > 0 ? { questions } : {}) }
      : null;
  }
  if (kind !== 'activity') return null;
  const label = stringValue(record.label);
  if (!label) return null;
  const activity = stringValue(record.activity) ?? 'tool';
  return {
    id,
    kind,
    activity,
    label,
    detail: stringValue(record.detail) ?? '',
    status: stringValue(record.status) ?? 'completed',
    ...(activity === 'command' ? {
      ...(typeof record.output === 'string' ? { output: record.output } : {}),
      ...(stringValue(record.cwd) ? { cwd: record.cwd as string } : {}),
      ...(typeof record.exitCode === 'number' && Number.isSafeInteger(record.exitCode)
        ? { exitCode: record.exitCode } : {}),
      ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
        ? { durationMs: record.durationMs } : {}),
    } : {}),
    ...(activity === 'files'
      ? {
          changes: Array.isArray(record.changes)
            ? record.changes.map(normalizeFileChange).filter((change): change is ChatFileChange => change !== null)
            : [],
        }
      : {}),
  };
}

export function normalizeSessionsResponse(value: unknown): ChatSession[] {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.sessions)) throw new Error('The chat session list response is invalid.');
  return record.sessions.map(normalizeSession).filter((session): session is ChatSession => session !== null);
}

function deletedSessionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0
    || value.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())) return null;
  return [...new Set(value as string[])];
}

export function normalizeDeletedSessionsResponse(value: unknown, expectedSessionId?: string): string[] {
  const threadIds = deletedSessionIds(recordValue(value)?.threadIds);
  if (!threadIds) throw new Error('The deleted chat session response is invalid.');
  if (expectedSessionId && !threadIds.includes(expectedSessionId)) throw new Error('The deleted chat session response does not match this chat.');
  return threadIds;
}

export function normalizeAgentsResponse(value: unknown): ChatAgentThread[] {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.agents)) throw new Error('The Codex agent thread response is invalid.');
  return record.agents
    .map(normalizeAgentThread)
    .filter((agent): agent is ChatAgentThread => agent !== null);
}

export function normalizeSkillsResponse(value: unknown): ChatSkill[] {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.skills)) throw new Error('The Codex skills response is invalid.');
  return record.skills.map(normalizeSkill).filter((skill): skill is ChatSkill => skill !== null);
}

export function normalizeMcpServersResponse(value: unknown): ChatMcpServer[] {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.servers)) throw new Error('The Codex MCP server response is invalid.');
  return record.servers.map(normalizeMcpServer).filter((server): server is ChatMcpServer => server !== null);
}

export function normalizeGoalResponse(value: unknown): { goal: ChatGoal | null } {
  const record = recordValue(value);
  if (!record || !Object.hasOwn(record, 'goal')) throw new Error('The Codex goal response is invalid.');
  if (record.goal === null) return { goal: null };
  const goal = normalizeGoal(record.goal);
  if (!goal) throw new Error('The Codex goal response is invalid.');
  return { goal };
}

export function normalizePermissionModesResponse(value: unknown): ChatPermissionModesResponse {
  const record = recordValue(value);
  const currentMode = normalizePermissionMode(record?.currentMode);
  if (!record || !Array.isArray(record.modes) || !currentMode) {
    throw new Error('The Codex permission modes response is invalid.');
  }
  return {
    modes: record.modes
      .map(normalizePermissionMode)
      .filter((mode): mode is ChatPermissionMode => mode !== null),
    currentMode,
  };
}

export function normalizePermissionModeResponse(value: unknown): { mode: ChatPermissionMode } {
  const record = recordValue(value);
  const mode = normalizePermissionMode(record?.mode);
  if (!record || !mode) throw new Error('The Codex permission mode response is invalid.');
  return { mode };
}

export function normalizeChatConfiguration(value: unknown): ChatConfiguration {
  const record = recordValue(value);
  const model = record?.model === null ? null : stringValue(record?.model);
  const modelDisplayName = stringValue(record?.modelDisplayName);
  const reasoningEffort = stringValue(record?.reasoningEffort);
  const serviceTier = record?.serviceTier === null ? null : stringValue(record?.serviceTier);
  const serviceTierDisplayName = stringValue(record?.serviceTierDisplayName);
  const fastModeAvailable = record?.fastModeAvailable;
  const fastModeEnabled = record?.fastModeEnabled;
  if (
    !record
    || (record.model !== null && !model)
    || !modelDisplayName
    || !reasoningEffort
    || (record.serviceTier !== null && !serviceTier)
    || !serviceTierDisplayName
    || (fastModeAvailable !== true && fastModeAvailable !== false)
    || (fastModeEnabled !== true && fastModeEnabled !== false)
    || (record.collaborationMode !== undefined && record.collaborationMode !== 'default' && record.collaborationMode !== 'plan')
  ) {
    throw new Error('The Codex chat configuration response is invalid.');
  }
  return {
    model,
    modelDisplayName,
    reasoningEffort,
    supportedReasoningEfforts: Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts
          .map(normalizeReasoningEffort)
          .filter((option): option is ChatReasoningEffort => option !== null)
      : [],
    serviceTier,
    serviceTierDisplayName,
    fastModeAvailable,
    fastModeEnabled,
    ...(record.collaborationMode === 'default' || record.collaborationMode === 'plan' ? { collaborationMode: record.collaborationMode } : {}),
  };
}

export function normalizeModelsResponse(value: unknown): ChatModelCatalog {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.models)) throw new Error('The Codex model response is invalid.');
  return {
    models: record.models.map(normalizeModel).filter((model): model is ChatModel => model !== null),
    configuration: normalizeChatConfiguration(record.configuration),
  };
}

export function normalizeChatCommandStatus(value: unknown): ChatCommandStatus {
  const record = recordValue(value);
  const configuration = normalizeChatConfiguration(value);
  const threadId = record?.threadId === null ? null : stringValue(record?.threadId);
  const access = stringValue(record?.access);
  if (!record || (record.threadId !== null && !threadId) || !access || typeof record.responseInProgress !== 'boolean') {
    throw new Error('The Codex chat status response is invalid.');
  }
  return {
    ...configuration,
    threadId,
    access,
    responseInProgress: record.responseInProgress,
  };
}

export function normalizeOpenSessionResponse(value: unknown): {
  session: ChatSession;
  items: ChatTimelineItem[];
  responseInProgress: boolean;
  responseThreadIds: string[];
} {
  const record = recordValue(value);
  const session = normalizeSession(record?.session);
  const responseInProgress = record?.responseInProgress === true;
  const responseThreadIds = responseInProgress && Array.isArray(record?.responseThreadIds)
    ? record.responseThreadIds.map(stringValue)
    : [];
  if (
    !record
    || !session
    || !Array.isArray(record.items)
    || (responseInProgress && (responseThreadIds.length === 0 || responseThreadIds.includes(null)))
  ) throw new Error('The chat session response is invalid.');
  return {
    session,
    items: record.items.map(normalizeTimelineItem).filter((item): item is ChatTimelineItem => item !== null),
    responseInProgress,
    responseThreadIds: [...new Set(responseThreadIds as string[])],
  };
}

export function normalizeSendResponse(value: unknown): { threadId: string } {
  const record = recordValue(value);
  const threadId = stringValue(record?.threadId);
  if (!record || !threadId) throw new Error('The chat response did not include a session id.');
  return { threadId };
}

export function normalizeChatEvent(value: unknown): ChatEvent | null {
  const record = recordValue(value);
  const type = stringValue(record?.type);
  if (!record || !type) return null;
  if (type === 'session-created') {
    const session = normalizeSession(record.session);
    return session ? { type, session } : null;
  }
  if (type === 'session-selected') {
    const threadId = stringValue(record.threadId);
    return threadId ? { type, threadId, previousThreadId: stringValue(record.previousThreadId) } : null;
  }
  if (type === 'session-title') {
    const threadId = stringValue(record.threadId);
    const title = stringValue(record.title);
    return threadId && title ? { type, threadId, title } : null;
  }
  if (type === 'turn-started') {
    const threadId = stringValue(record.threadId);
    return threadId ? { type, threadId } : null;
  }
  if (type === 'user-message-identified') {
    const threadId = stringValue(record.threadId);
    const clientMessageId = stringValue(record.clientMessageId);
    const itemId = stringValue(record.itemId);
    return threadId && clientMessageId && itemId ? { type, threadId, clientMessageId, itemId } : null;
  }
  if (type === 'user-message') {
    const threadId = stringValue(record.threadId);
    const clientMessageId = stringValue(record.clientMessageId);
    const text = stringValue(record.text);
    return threadId && clientMessageId && text
      ? { type, threadId, clientMessageId, text, createdAt: finiteNumber(record.createdAt) ?? Math.floor(Date.now() / 1000) }
      : null;
  }
  if (type === 'command-output-delta') {
    const threadId = stringValue(record.threadId);
    const itemId = stringValue(record.itemId);
    const text = stringValue(record.text);
    return threadId && itemId && text ? { type, threadId, itemId, text } : null;
  }
  if (type === 'assistant-delta' || type === 'reasoning-delta' || type === 'plan-delta' || type === 'plan-completed') {
    const threadId = stringValue(record.threadId);
    const itemId = stringValue(record.itemId);
    const text = type === 'plan-completed' && typeof record.text === 'string' ? record.text : stringValue(record.text);
    return threadId && itemId && text !== null
      ? { type, threadId, itemId, text, createdAt: finiteNumber(record.createdAt) ?? Math.floor(Date.now() / 1000) }
      : null;
  }
  if (type === 'assistant-questions') {
    const threadId = stringValue(record.threadId);
    const itemId = stringValue(record.itemId);
    const questions = normalizeChatAsyncQuestions(record.questions);
    return threadId && itemId && questions.length > 0
      ? { type, threadId, itemId, questions, createdAt: finiteNumber(record.createdAt) ?? Math.floor(Date.now() / 1000) }
      : null;
  }
  if (type === 'activity') {
    const threadId = stringValue(record.threadId);
    const item = normalizeTimelineItem(record.item);
    return threadId && item?.kind === 'activity' ? { type, threadId, item } : null;
  }
  if (type === 'turn-completed') {
    const threadId = stringValue(record.threadId);
    if (!threadId) return null;
    return {
      type,
      threadId,
      status: stringValue(record.status) ?? 'completed',
      message: stringValue(record.message),
    };
  }
  if (type === 'permission-mode-changed') {
    const mode = normalizePermissionMode(record.mode);
    return mode ? { type, mode } : null;
  }
  if (type === 'approval-requested') {
    const approval = normalizeApprovalRequest(record.approval);
    return approval ? { type, approval } : null;
  }
  if (type === 'approval-resolved') {
    const approvalId = stringValue(record.approvalId);
    const threadId = stringValue(record.threadId);
    return approvalId && threadId ? { type, approvalId, threadId } : null;
  }
  if (type === 'sessions-changed') return { type };
  if (type === 'sessions-deleted') {
    const threadIds = deletedSessionIds(record.threadIds);
    return threadIds ? { type, threadIds } : null;
  }
  if (type === 'error') {
    const message = stringValue(record.message);
    const threadId = record.threadId === undefined ? null : stringValue(record.threadId);
    return message && (record.threadId === undefined || threadId) ? { type, threadId, message } : null;
  }
  return null;
}

export { chatReducer } from './chatReducer';
