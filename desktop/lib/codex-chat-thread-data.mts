import type { ChatAgentThread, ChatGoal, JsonObject } from "./codex-chat-types.mts";
import { finiteNumber, recordValue, stringValue } from "./codex-service-utils.mts";
import { chatRelaySessionTitle } from '../shared/chat-relay.ts';
import {
  parseSavedChatTurnPrompt,
  savedChatTurnSessionTitle,
} from "../shared/chat-saved-turn-continuation.ts";

const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function turnErrorMessage(value: unknown): string {
  const params = recordValue(value);
  const error = recordValue(params?.error);
  return (
    stringValue(error?.message) ??
    stringValue(params?.message) ??
    "Codex returned an error."
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function threadStatus(value: unknown): string {
  return stringValue(recordValue(value)?.type) ?? "notLoaded";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function itemStatus(value: unknown): string {
  return stringValue(value) ?? "completed";
}

function textFromUserInputPart(part: JsonObject | null): string {
  const type = stringValue(part?.type);
  if (type === "text") return stringValue(part?.text) ?? "";
  if (type === "mention")
    return stringValue(part?.name) ? `@${String(part?.name)}` : "";
  if (type === "skill")
    return stringValue(part?.name) ? `$${String(part?.name)}` : "";
  if (type === "localImage")
    return stringValue(part?.path)
      ? `[Image: ${String(part?.path)}]`
      : "[Image]";
  if (type === "image") return "[Image]";
  if (type === "localAudio")
    return stringValue(part?.path)
      ? `[Audio: ${String(part?.path)}]`
      : "[Audio]";
  if (type === "audio") return "[Audio]";
  return "";
}

function textFromUserInput(value: unknown): string {
  if (!Array.isArray(value)) return "";
  let text = "";
  let previousWasImage = false;
  for (const partValue of value) {
    const part = recordValue(partValue);
    const partText = textFromUserInputPart(part);
    if (!partText) continue;
    const isImage = part?.type === "localImage";
    // Keep image markers outside Markdown lists from adjacent text attachments.
    if (text) text += previousWasImage || isImage ? "\n\n" : "\n";
    text += partText;
    previousWasImage = isImage;
  }
  return text;
}

/**
 * @param {unknown} value
 * @returns {ChatGoal | null}
 */
function chatGoalFromValue(value: unknown): ChatGoal | null {
  const goal = recordValue(value);
  const threadId = stringValue(goal?.threadId)?.trim();
  const objective = stringValue(goal?.objective)?.trim();
  const status = stringValue(goal?.status);
  const tokenBudget =
    goal?.tokenBudget === null ? null : finiteNumber(goal?.tokenBudget);
  const tokensUsed = finiteNumber(goal?.tokensUsed);
  const timeUsedSeconds = finiteNumber(goal?.timeUsedSeconds);
  if (
    !goal ||
    !threadId ||
    !objective ||
    !status ||
    !GOAL_STATUSES.has(status) ||
    (goal.tokenBudget !== null && tokenBudget === null) ||
    tokensUsed === null ||
    timeUsedSeconds === null
  )
    return null;
  return {
    threadId,
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
  };
}

/**
 * @param {unknown} value
 * @returns {{ goal: ChatGoal | null }}
 */
export function goalFromResponse(value: unknown): { goal: ChatGoal | null } {
  const response = recordValue(value);
  if (!response || !Object.hasOwn(response, "goal")) {
    throw new Error("The Codex goal response format is invalid.");
  }
  if (response.goal === null) return { goal: null };
  const goal = chatGoalFromValue(response.goal);
  if (!goal) throw new Error("The Codex goal response format is invalid.");
  return { goal };
}

/**
 * @param {JsonObject} item
 * @returns {string}
 */
export function textFromReasoningItem(item: JsonObject): string {
  return [item.summary, item.content]
    .flatMap((value) =>
      Array.isArray(value)
        ? value.filter((part) => typeof part === "string" && part.length > 0)
        : [],
    )
    .join("\n\n");
}

/**
 * Preserve the structured patch payload emitted by the v2 app-server protocol.
 * The object-shaped branch keeps older persisted rollout items readable too.
 *
 * @param {unknown} value
 * @returns {JsonObject[]}
 */
function fileChangesFromValue(value: unknown): JsonObject[] {
  /** @type {JsonObject[]} */
  const changes: JsonObject[] = [];

  /**
   * @param {unknown} pathValue
   * @param {unknown} changeValue
   */
  const append = (pathValue: unknown, changeValue: unknown) => {
    const change = recordValue(changeValue);
    const path = stringValue(pathValue) ?? stringValue(change?.path);
    if (!change || !path) return;

    const kindRecord = recordValue(change.kind);
    const kind =
      stringValue(kindRecord?.type) ??
      stringValue(change.kind) ??
      stringValue(change.type);
    if (kind !== "add" && kind !== "delete" && kind !== "update") return;

    changes.push({
      path,
      kind,
      diff:
        stringValue(change.diff) ??
        stringValue(change.unified_diff) ??
        stringValue(change.content) ??
        "",
      movePath:
        kind === "update"
          ? (stringValue(kindRecord?.move_path) ??
            stringValue(change.move_path))
          : null,
    });
  };

  if (Array.isArray(value)) {
    for (const changeValue of value) append(null, changeValue);
    return changes;
  }

  const changeRecord = recordValue(value);
  if (!changeRecord) return changes;
  for (const [path, changeValue] of Object.entries(changeRecord))
    append(path, changeValue);
  return changes;
}

/**
 * @param {JsonObject} item
 * @param {'started' | 'completed'} phase
 * @param {string} fallbackId
 * @returns {JsonObject | null}
 */
export function activityFromItem(
  item: JsonObject,
  phase: "started" | "completed",
  fallbackId: string,
): JsonObject | null {
  const type = stringValue(item.type);
  const id = stringValue(item.id) ?? fallbackId;
  const fallbackStatus = phase === "started" ? "inProgress" : "completed";
  if (type === "commandExecution") {
    const cwd = stringValue(item.cwd);
    const exitCode = finiteNumber(item.exitCode);
    const durationMs = finiteNumber(item.durationMs);
    return {
      id,
      kind: "activity",
      activity: "command",
      label: "Command",
      detail: stringValue(item.command) ?? "Running command",
      status: itemStatus(item.status ?? fallbackStatus),
      ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}),
      ...(cwd !== null ? { cwd } : {}),
      ...(exitCode !== null && Number.isInteger(exitCode) ? { exitCode } : {}),
      ...(durationMs !== null && durationMs >= 0 ? { durationMs } : {}),
    };
  }
  if (type === "fileChange") {
    const changes = fileChangesFromValue(item.changes);
    const count = changes.length;
    return {
      id,
      kind: "activity",
      activity: "files",
      label: "File changes",
      detail: count === 1 ? "1 file" : `${count} files`,
      status: itemStatus(item.status ?? fallbackStatus),
      changes,
    };
  }
  if (type === "mcpToolCall") {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool);
    return {
      id,
      kind: "activity",
      activity: "tool",
      label: tool ?? "Tool call",
      detail: server ?? "MCP",
      status: itemStatus(item.status ?? fallbackStatus),
    };
  }
  if (type === "dynamicToolCall") {
    const namespace = stringValue(item.namespace);
    const tool = stringValue(item.tool);
    return {
      id,
      kind: "activity",
      activity: "tool",
      label: tool ?? "Tool call",
      detail: namespace ?? "Codex",
      status: itemStatus(item.status ?? fallbackStatus),
    };
  }
  if (type === "webSearch") {
    return {
      id,
      kind: "activity",
      activity: "search",
      label: "Web search",
      detail: stringValue(item.query) ?? "Searching the web",
      status: fallbackStatus,
    };
  }
  if (type === "imageGeneration") {
    return {
      id,
      kind: "activity",
      activity: "image",
      label: "Image generation",
      detail: stringValue(item.revisedPrompt) ?? "Generating an image",
      status: itemStatus(item.status ?? fallbackStatus),
    };
  }
  if (type === "collabAgentToolCall" || type === "subAgentActivity") {
    return {
      id,
      kind: "activity",
      activity: "agent",
      label: type === "subAgentActivity" ? "Agent activity" : "Collaboration",
      detail:
        stringValue(item.prompt) ??
        stringValue(item.agentPath) ??
        "Coordinating agents",
      status: itemStatus(item.status ?? item.kind ?? fallbackStatus),
    };
  }
  if (type === "contextCompaction") {
    return {
      id,
      kind: "activity",
      activity: "context",
      label: "Context compacted",
      detail: "Conversation context was summarized",
      status: "completed",
    };
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {JsonObject[]}
 */
export function timelineFromThread(value: unknown): JsonObject[] {
  const response = recordValue(value);
  const thread = recordValue(response?.thread) ?? response;
  if (!thread) throw new Error("The Codex thread response format is invalid.");
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  /** @type {JsonObject[]} */
  const timeline: JsonObject[] = [];
  for (const [turnIndex, turnValue] of turns.entries()) {
    const turn = recordValue(turnValue);
    if (!turn) continue;
    const sourceTurnId = stringValue(turn.id);
    const turnId = sourceTurnId ?? `turn-${turnIndex}`;
    const firstItem = timeline.length;
    const startedAt = finiteNumber(turn.startedAt) ?? 0;
    const completedAt = finiteNumber(turn.completedAt) ?? startedAt;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const [itemIndex, itemValue] of items.entries()) {
      const item = recordValue(itemValue);
      if (!item) continue;
      const id = stringValue(item.id) ?? `${turnId}:${itemIndex}`;
      const type = stringValue(item.type);
      if (type === "userMessage") {
        const text = textFromUserInput(item.content).trim();
        if (text)
          timeline.push({ id, kind: "user", text, createdAt: startedAt });
        continue;
      }
      if (type === "agentMessage") {
        const text = stringValue(item.text)?.trim();
        if (text)
          timeline.push({
            id,
            kind: "assistant",
            text,
            createdAt: completedAt,
          });
        continue;
      }
      if (type === "reasoning") {
        const text = textFromReasoningItem(item).trim();
        if (text)
          timeline.push({ id, kind: "reasoning", text, createdAt: startedAt });
        continue;
      }
      if (type === "plan") {
        const text = stringValue(item.text)?.trim();
        if (text)
          timeline.push({ id, kind: "plan", text, createdAt: completedAt });
        continue;
      }
      const activity = activityFromItem(item, "completed", id);
      if (activity) {
        if (activity.status === 'inProgress' && (turn.status === 'interrupted' || turn.status === 'failed')) {
          activity.status = turn.status;
        }
        timeline.push(activity);
      }
    }
    const turnError = recordValue(turn.error);
    const message = stringValue(turnError?.message);
    if (message) {
      timeline.push({
        id: `${turnId}:error`,
        kind: "activity",
        activity: "error",
        label: "Response failed",
        detail: message,
        status: "failed",
      });
    }
    if (sourceTurnId) {
      for (let index = firstItem; index < timeline.length; index++) timeline[index]!.turnId = sourceTurnId;
    }
  }
  return timeline;
}

function normalizedSavedTurnText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * @param {unknown} value
 * @returns {JsonObject | null}
 */
export function chatSessionFromThread(value: unknown): JsonObject | null {
  const thread = recordValue(value);
  const id = stringValue(thread?.id);
  if (!thread || !id) return null;
  const rawName = stringValue(thread.name)?.trim();
  const agentNickname = stringValue(thread.agentNickname)?.trim();
  const agentRole = stringValue(thread.agentRole)?.trim();
  const rawPreview = stringValue(thread.preview)?.trim() ?? "";
  const relayTitle = chatRelaySessionTitle(rawPreview);
  const relayName = chatRelaySessionTitle(rawName ?? "");
  const savedContext = parseSavedChatTurnPrompt(rawPreview);
  const savedTitle = savedChatTurnSessionTitle(rawPreview);
  const savedName = rawName ? savedChatTurnSessionTitle(rawName) : null;
  const normalizedPreview = normalizedSavedTurnText(rawPreview);
  const namePrefix = normalizedSavedTurnText(rawName ?? "").replace(/(?:\.\.\.|…)$/, "").trimEnd();
  const nameUsesSavedPreview = savedContext && namePrefix
    && namePrefix.length >= normalizedPreview.indexOf("\n")
    && normalizedPreview.startsWith(namePrefix);
  const name = savedName || nameUsesSavedPreview
    ? (savedContext ? savedTitle : savedName)
    : relayName ? relayTitle ?? relayName : rawName;
  const preview = savedContext
    ? savedContext.userText.trim() || savedTitle || ""
    : savedTitle ?? relayTitle ?? rawPreview;
  return {
    id,
    title:
      name ||
      agentNickname ||
      agentRole ||
      savedTitle ||
      preview ||
      (stringValue(thread.parentThreadId) ? "Subagent" : "New chat"),
    preview,
    createdAt: finiteNumber(thread.createdAt) ?? 0,
    updatedAt:
      finiteNumber(thread.recencyAt) ??
      finiteNumber(thread.updatedAt) ??
      finiteNumber(thread.createdAt) ??
      0,
    status: threadStatus(thread.status),
  };
}

/** Detects internal sessions even when list metadata has no parent identifier. */
export function isSubagentThread(value: unknown): boolean {
  const thread = recordValue(value);
  const source = thread?.source;
  const structuredSource = recordValue(source);
  // List responses can omit the parent even when thread/read supplies it.
  return stringValue(thread?.parentThreadId) !== null
    || (typeof source === 'string' && source.startsWith('subAgent'))
    || (structuredSource !== null && Object.hasOwn(structuredSource, 'subAgent'));
}

export function sessionFromThread(value: unknown): JsonObject | null {
  const thread = recordValue(value);
  if (!thread || isSubagentThread(thread)) return null;
  return chatSessionFromThread(thread);
}

/**
 * @param {unknown} value
 * @returns {JsonObject}
 */
export function threadFromReadResponse(value: unknown): JsonObject {
  const response = recordValue(value);
  const thread = recordValue(response?.thread);
  if (!thread || !stringValue(thread.id))
    throw new Error("The Codex thread response format is invalid.");
  return thread;
}

/**
 * @param {JsonObject} thread
 * @param {string} rootThreadId
 * @param {string} currentThreadId
 * @param {number} depth
 * @returns {ChatAgentThread | null}
 */
export function agentFromThread(
  thread: JsonObject,
  rootThreadId: string,
  currentThreadId: string,
  depth: number,
): ChatAgentThread | null {
  const id = stringValue(thread.id);
  if (!id) return null;
  const isRoot = id === rootThreadId;
  const parentThreadId = stringValue(thread.parentThreadId);
  const nickname = stringValue(thread.agentNickname)?.trim() || null;
  const role = stringValue(thread.agentRole)?.trim() || null;
  const name = stringValue(thread.name)?.trim();
  const preview = stringValue(thread.preview)?.trim();
  const title = isRoot
    ? "Main agent"
    : nickname || role || name || preview || "Subagent";
  const description = (
    isRoot ? [name || preview || "Current chat"] : [role, name, preview]
  )
    .filter(
      (value, index, values) =>
        value && value !== title && values.indexOf(value) === index,
    )
    .join(" · ");
  return {
    id,
    parentThreadId,
    title,
    description:
      description || (isRoot ? "Current chat" : "Spawned agent thread"),
    kind: isRoot ? "main" : "subagent",
    role,
    depth,
    status: threadStatus(thread.status),
    current: id === currentThreadId,
  };
}

/**
 * @param {JsonObject} thread
 * @param {string} rootThreadId
 * @param {Map<string, JsonObject>} threadsById
 * @returns {number}
 */
export function agentThreadDepth(
  thread: JsonObject,
  rootThreadId: string,
  threadsById: Map<string, JsonObject>,
): number {
  let depth = 0;
  let current = thread;
  const visited = new Set();
  while (stringValue(current.id) !== rootThreadId) {
    const currentId = stringValue(current.id);
    const parentThreadId = stringValue(current.parentThreadId);
    if (!currentId || !parentThreadId || visited.has(currentId)) break;
    visited.add(currentId);
    depth += 1;
    const parent = threadsById.get(parentThreadId);
    if (!parent) break;
    current = parent;
  }
  return depth;
}

/**
 * @param {JsonObject} thread
 * @param {string} rootThreadId
 * @param {string | null} rootSessionId
 * @param {Map<string, JsonObject>} threadsById
 * @returns {boolean}
 */
export function belongsToAgentTree(
  thread: JsonObject,
  rootThreadId: string,
  threadsById: Map<string, JsonObject>,
): boolean {
  const id = stringValue(thread.id);
  if (!id) return false;
  if (id === rootThreadId) return true;
  if (!stringValue(thread.parentThreadId)) return false;
  let current = thread;
  const visited = new Set();
  while (true) {
    const currentId = stringValue(current.id);
    const parentThreadId = stringValue(current.parentThreadId);
    if (!currentId || !parentThreadId || visited.has(currentId)) return false;
    if (parentThreadId === rootThreadId) return true;
    visited.add(currentId);
    const parent = threadsById.get(parentThreadId);
    if (!parent) return false;
    current = parent;
  }
}

/**
 * @param {unknown} value
 * @returns {JsonObject[]}
 */
export function sessionsFromListResponse(value: unknown): JsonObject[] {
  const response = recordValue(value);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("The Codex thread list response format is invalid.");
  }
  return response.data.flatMap((thread) => {
    const session = sessionFromThread(thread);
    return session ? [session] : [];
  });
}
