import {
  agentFromThread,
  agentThreadDepth,
  belongsToAgentTree,
  goalFromResponse,
  sessionsFromListResponse,
  threadFromReadResponse,
} from "./codex-chat-thread-data.mts";
import type {
  ChatAgentThread,
  ChatGoal,
  CodexChatClient,
  JsonObject,
} from "./codex-chat-types.mts";
import { requiredString } from "./codex-chat-values.mts";
import { recordValue, stringValue } from "./codex-service-utils.mts";
import type { CodexConversationAccess } from './codex-chat-account-continuity.mts';

const SESSION_LIST_LIMIT = 100;

interface CodexChatThreadContext {
  conversations?: CodexConversationAccess;
  viewedThreadIsSubagent?: boolean;
  client: CodexChatClient;
  cwd: string;
  viewedThreadId: string | null;
  availableAgentThreadIds: Set<string>;
  readThread(threadId: string): Promise<JsonObject>;
  listAgentDescendants(rootThreadId: string): Promise<JsonObject[]>;
  isThreadActive(threadId: string | null): boolean;
  ensureWritableThread(targetThreadId?: unknown): Promise<string>;
  emit(event: JsonObject): void;
}

/** @returns {Promise<{ sessions: JsonObject[] }>} */
export async function listCodexSessions(context: CodexChatThreadContext): Promise<{ sessions: JsonObject[] }> {
  const raw = await context.client.request("thread/list", {
    limit: SESSION_LIST_LIMIT,
    sortKey: "recency_at",
    sortDirection: "desc",
    cwd: context.cwd,
  });
  return { sessions: sessionsFromListResponse(raw) };
}

/** @returns {Promise<{ agents: ChatAgentThread[] }>} */
export async function listCodexAgents(context: CodexChatThreadContext): Promise<{ agents: ChatAgentThread[] }> {
  const currentThreadId = context.viewedThreadId;
  if (!currentThreadId) throw new Error("Open a chat to view its agents.");

  const currentThread = await context.readThread(currentThreadId);
  const ancestorThreads = [currentThread];
  let rootThread = currentThread;
  const visitedAncestorIds = new Set([currentThreadId]);
  let parentThreadId = stringValue(rootThread.parentThreadId);
  while (parentThreadId) {
    if (visitedAncestorIds.has(parentThreadId)) {
      throw new Error("The Codex agent thread hierarchy contains a cycle.");
    }
    visitedAncestorIds.add(parentThreadId);
    rootThread = await context.readThread(parentThreadId);
    ancestorThreads.push(rootThread);
    parentThreadId = stringValue(rootThread.parentThreadId);
  }

  const rootThreadId = requiredString(rootThread.id, "Root thread id");
  const descendants = await context.listAgentDescendants(rootThreadId);
  const threadsById = new Map<string, JsonObject>();
  for (const thread of [rootThread, ...descendants, ...ancestorThreads]) {
    const id = stringValue(thread.id);
    if (id && !threadsById.has(id)) threadsById.set(id, thread);
  }
  const agents = [...threadsById.values()].flatMap((thread) => {
    if (!belongsToAgentTree(thread, rootThreadId, threadsById))
      return [];
    const agent = agentFromThread(
      thread,
      rootThreadId,
      currentThreadId,
      agentThreadDepth(thread, rootThreadId, threadsById),
    );
    return agent ? [agent] : [];
  });
  context.availableAgentThreadIds = new Set(agents.map(({ id }) => id));
  return { agents };
}

/**
 * @param {string} threadId
 * @returns {Promise<JsonObject>}
 */
export async function readCodexThread(context: CodexChatThreadContext, threadId: string): Promise<JsonObject> {
  return threadFromReadResponse(
    context.conversations?.agents ? await context.conversations.agents.read(threadId, 'thread/read', { includeTurns: false })
      : await context.client.request("thread/read", {
      threadId,
      includeTurns: false,
    }),
  );
}

/**
 * @param {string} rootThreadId
 * @returns {Promise<JsonObject[]>}
 */
export async function listCodexAgentDescendants(context: CodexChatThreadContext, rootThreadId: string): Promise<JsonObject[]> {
  if (context.conversations?.agents) return context.conversations.agents.descendants(rootThreadId);
  /** @type {JsonObject[]} */
  const descendants: JsonObject[] = [];
  /** @type {string | null} */
  let cursor: string | null = null;
  const seenCursors = new Set();
  do {
    const raw = await context.client.request("thread/list", {
      limit: SESSION_LIST_LIMIT,
      sortKey: "created_at",
      sortDirection: "asc",
      ancestorThreadId: rootThreadId,
      ...(cursor ? { cursor } : {}),
    });
    const response = recordValue(raw);
    if (!response || !Array.isArray(response.data)) {
      throw new Error(
        "The Codex agent thread list response format is invalid.",
      );
    }
    descendants.push(
      ...response.data.flatMap((value) => {
        const thread = recordValue(value);
        return thread && stringValue(thread.id) ? [thread] : [];
      }),
    );
    cursor = stringValue(response.nextCursor);
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(
        "The Codex agent thread list returned a repeated cursor.",
      );
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return descendants;
}

/** @returns {Promise<{ goal: ChatGoal | null }>} */
export async function getCodexGoal(context: CodexChatThreadContext): Promise<{ goal: ChatGoal | null }> {
  const threadId = context.viewedThreadId;
  if (!threadId) return { goal: null };
  return goalFromResponse(
    context.viewedThreadIsSubagent && context.conversations?.agents
      ? await context.conversations.agents.read(threadId, 'thread/goal/get')
      : context.conversations?.read && !context.viewedThreadIsSubagent
      ? await context.conversations.read(threadId, 'thread/goal/get')
      : await context.client.request("thread/goal/get", { threadId }),
  );
}

/**
 * @param {unknown} objective
 * @returns {Promise<{ goal: ChatGoal }>}
 */
export async function setCodexGoal(context: CodexChatThreadContext, objective: unknown): Promise<{ goal: ChatGoal }> {
  if (context.isThreadActive(context.viewedThreadId))
    throw new Error("A response is already in progress for this chat.");
  const goalObjective = requiredString(objective, "Goal objective");
  const threadId = await context.ensureWritableThread();
  const response = goalFromResponse(
    await context.client.request("thread/goal/set", {
      threadId,
      objective: goalObjective,
      status: "active",
    }),
  );
  if (!response.goal)
    throw new Error("Codex did not return the persistent goal.");
  context.emit({ type: "sessions-changed" });
  return { goal: response.goal };
}
