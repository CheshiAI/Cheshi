import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_METHODS,
  approvalPresentation,
  approvalResponse,
} from "./codex-chat-permissions.mts";
import {
  activityFromItem,
  textFromReasoningItem,
  turnErrorMessage,
} from "./codex-chat-thread-data.mts";
import type {
  ActiveTurn,
  ApprovalDecision,
  ChatApprovalRequest,
  CodexChatClient,
  JsonObject,
} from "./codex-chat-types.mts";
import { errorMessage, requiredString } from "./codex-chat-values.mts";
import { recordValue, stringValue } from "./codex-service-utils.mts";
import { chatRelaySessionTitle } from '../shared/chat-relay.ts';
import { asyncQuestionsFromMessage } from '../shared/chat-async-questions.ts';

interface CodexChatEventContext {
  client: CodexChatClient;
  activeTurns: Map<string, ActiveTurn>;
  pendingApprovals: Map<string, {
    serverRequestId: string | number;
    method: string;
    params: JsonObject;
    threadId: string;
  }>;
  approvalSequence: number;
  pendingNewTurnClientMessageId: string | null;
  viewedThreadId: string | null;
  subscribedThreadIds: Set<string>;
  emit(event: JsonObject): void;
  activeTurnFromParams(params: JsonObject): ActiveTurn | null;
  acceptTurnId(active: ActiveTurn, turnId: string): void;
  clearPendingApprovals(threadId?: string | null): void;
  releaseThreadSubscription(threadId: string | null, operation: string): Promise<void>;
}

/** @param {JsonObject} value */
export function handleCodexRequest(context: CodexChatEventContext, value: JsonObject) {
  const method = stringValue(value.method);
  const params = recordValue(value.params);
  const serverRequestId =
    typeof value.id === "number" || typeof value.id === "string"
      ? value.id
      : null;
  if (
    !method ||
    !params ||
    serverRequestId === null ||
    !APPROVAL_REQUEST_METHODS.has(method)
  )
    return;

  const presentation = approvalPresentation(method, params);
  const threadId =
    context.activeTurnFromParams(params)?.threadId ?? context.viewedThreadId;
  if (!threadId) return;
  const id = `approval-${++context.approvalSequence}`;
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : null;
  /** @type {ChatApprovalRequest} */
  const approval: ChatApprovalRequest = {
    id,
    threadId,
    ...presentation,
    canAllowForSession:
      method !== "item/commandExecution/requestApproval" ||
      availableDecisions === null ||
      availableDecisions.includes("acceptForSession"),
  };
  context.pendingApprovals.set(id, {
    serverRequestId,
    method,
    params,
    threadId,
  });
  context.emit({ type: "approval-requested", approval });
}

/**
 * @param {unknown} approvalId
 * @param {unknown} decisionValue
 * @returns {Promise<{ approvalId: string }>}
 */
export async function respondToCodexApproval(context: CodexChatEventContext, approvalId: unknown, decisionValue: unknown): Promise<{ approvalId: string }> {
  const id = requiredString(approvalId, "Approval request id");
  const decision = requiredString(decisionValue, "Approval decision");
  if (!APPROVAL_DECISIONS.has(decision as ApprovalDecision))
    throw new TypeError("The approval decision is invalid.");
  const pending = context.pendingApprovals.get(id);
  if (!pending) throw new Error("The approval request is no longer active.");
  await context.client.respond(
    pending.serverRequestId,
    approvalResponse(
      pending.method,
      pending.params,
      decision as ApprovalDecision,
    ),
  );
  context.pendingApprovals.delete(id);
  context.emit({
    type: "approval-resolved",
    approvalId: id,
    threadId: pending.threadId,
  });
  return { approvalId: id };
}

/** @param {string | null} [threadId] */
export function clearCodexApprovals(context: CodexChatEventContext, threadId: string | null = null) {
  const approvals = [...context.pendingApprovals.entries()].filter(
    ([, pending]) => threadId === null || pending.threadId === threadId,
  );
  for (const [approvalId, pending] of approvals) {
    context.pendingApprovals.delete(approvalId);
    context.emit({
      type: "approval-resolved",
      approvalId,
      threadId: pending.threadId,
    });
  }
}

/**
 * @param {ActiveTurn} active
 * @param {string} turnId
 */
export function acceptCodexTurnId(context: CodexChatEventContext, active: ActiveTurn, turnId: string) {
  if (context.activeTurns.get(active.threadId) !== active) return;
  if (active.turnId && active.turnId !== turnId) return;
  active.turnId = turnId;
  if (active.startedEmitted) return;
  active.startedEmitted = true;
  context.emit({
    type: "turn-started",
    threadId: active.threadId,
    turnId,
    clientMessageId: active.clientMessageId,
  });
}

/**
 * @param {JsonObject} params
 * @returns {ActiveTurn | null}
 */
export function findActiveCodexTurn(context: CodexChatEventContext, params: JsonObject): ActiveTurn | null {
  const threadId = stringValue(params.threadId);
  if (threadId) return context.activeTurns.get(threadId) ?? null;
  const turn = recordValue(params.turn);
  const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
  if (turnId) {
    return (
      [...context.activeTurns.values()].find(
        (active) => active.turnId === turnId,
      ) ?? null
    );
  }
  return context.activeTurns.size === 1
    ? (context.activeTurns.values().next().value ?? null)
    : null;
}

/** @param {JsonObject} value */
export function handleCodexNotification(context: CodexChatEventContext, value: JsonObject) {
  const method = stringValue(value.method);
  const params = recordValue(value.params);
  if (!method || !params) return;

  if (method === "thread/name/updated") {
    const threadId = stringValue(params.threadId);
    const name = stringValue(params.threadName)?.trim() ?? "";
    if (threadId) {
      context.emit({
        type: "session-title",
        threadId,
        title: chatRelaySessionTitle(name) ?? (name || "New chat"),
      });
    }
    return;
  }

  let active = context.activeTurnFromParams(params);
  if (!active && method === "turn/started") {
    const threadId = stringValue(params.threadId);
    const turn = recordValue(params.turn);
    const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
    if (
      threadId &&
      turnId &&
      (threadId === context.viewedThreadId ||
        context.subscribedThreadIds.has(threadId))
    ) {
      active = {
        threadId,
        turnId,
        clientMessageId: `goal:${turnId}`,
        deltaItemIds: new Set(),
        commands: new Map(),
        interruptRequested: false,
        startedEmitted: true,
      };
      context.activeTurns.set(threadId, active);
      context.emit({
        type: "turn-started",
        threadId,
        turnId,
        clientMessageId: active.clientMessageId,
      });
    }
  }
  if (!active) return;
  const threadId = stringValue(params.threadId);
  if (threadId && threadId !== active.threadId) return;
  const turn = recordValue(params.turn);
  const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
  if (turnId && active.turnId && turnId !== active.turnId) return;
  if (turnId && !active.turnId) context.acceptTurnId(active, turnId);
  const activeThreadIsViewed = active.threadId === context.viewedThreadId;

  if (method === "turn/started") return;

  if (method === "item/plan/delta") {
    const delta = stringValue(params.delta);
    const itemId = stringValue(params.itemId);
    if (delta && itemId && activeThreadIsViewed) context.emit({ type: 'plan-delta', threadId: active.threadId, turnId: active.turnId, itemId, text: delta });
    return;
  }

  if (method === "item/agentMessage/delta") {
    const delta = stringValue(params.delta);
    const itemId = stringValue(params.itemId);
    if (!delta || !itemId || !activeThreadIsViewed) return;
    active.deltaItemIds.add(itemId);
    context.emit({
      type: "assistant-delta",
      threadId: active.threadId,
      turnId: active.turnId,
      itemId,
      text: delta,
    });
    return;
  }

  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta"
  ) {
    const delta = stringValue(params.delta);
    const itemId = stringValue(params.itemId);
    if (!delta || !itemId || !activeThreadIsViewed) return;
    active.deltaItemIds.add(itemId);
    context.emit({
      type: "reasoning-delta",
      threadId: active.threadId,
      turnId: active.turnId,
      itemId,
      text: delta,
    });
    return;
  }

  if (method === "item/commandExecution/outputDelta") {
    const delta = stringValue(params.delta);
    const itemId = stringValue(params.itemId);
    if (!delta || !itemId || !activeThreadIsViewed) return;
    context.emit({
      type: "command-output-delta",
      threadId: active.threadId,
      turnId: active.turnId,
      itemId,
      text: delta,
    });
    return;
  }

  if (method === "item/fileChange/patchUpdated") {
    const itemId = stringValue(params.itemId);
    if (!itemId || !activeThreadIsViewed) return;
    const activity = activityFromItem(
      {
        type: "fileChange",
        id: itemId,
        changes: params.changes,
        status: "inProgress",
      },
      "started",
      itemId,
    );
    if (activity)
      context.emit({
        type: "activity",
        threadId: active.threadId,
        turnId: active.turnId,
        item: activity,
      });
    return;
  }

  if (method === "item/started" || method === "item/completed") {
    const item = recordValue(params.item);
    if (!item) return;
    const itemId =
      stringValue(item.id) ?? `${active.turnId ?? "turn"}:activity`;
    if (item.type === 'userMessage') {
      // Codex echoes clientUserMessageId as clientId for both starts and steers.
      // Never infer this association from text or the active turn's first prompt.
      const clientMessageId = stringValue(item.clientId);
      const providerItemId = stringValue(item.id);
      if (activeThreadIsViewed && clientMessageId && providerItemId) {
        context.emit({ type: 'user-message-identified', threadId: active.threadId,
          clientMessageId, itemId: providerItemId });
      }
      return;
    }
    if (item.type === 'commandExecution') {
      active.commands.set(itemId, {
        processId: stringValue(item.processId) ?? active.commands.get(itemId)?.processId ?? null,
        completed: method === 'item/completed',
      });
    }
    if (method === "item/completed" && item.type === "plan") {
      if (typeof item.text === 'string' && activeThreadIsViewed) context.emit({ type: 'plan-completed', threadId: active.threadId, turnId: active.turnId, itemId, text: item.text });
      return;
    }
    if (method === "item/completed" && item.type === "agentMessage") {
      const text = stringValue(item.text);
      const questions = asyncQuestionsFromMessage(item);
      if (activeThreadIsViewed && questions && typeof item.text === 'string') {
        context.emit({ type: 'assistant-question', threadId: active.threadId, turnId: active.turnId,
          itemId, text: item.text, questions });
        return;
      }
      if (activeThreadIsViewed && text && !active.deltaItemIds.has(itemId)) {
        context.emit({
          type: "assistant-delta",
          threadId: active.threadId,
          turnId: active.turnId,
          itemId,
          text,
        });
      }
      return;
    }
    if (method === "item/completed" && item.type === "reasoning") {
      const text = textFromReasoningItem(item);
      if (activeThreadIsViewed && text && !active.deltaItemIds.has(itemId)) {
        context.emit({
          type: "reasoning-delta",
          threadId: active.threadId,
          turnId: active.turnId,
          itemId,
          text,
        });
      }
      return;
    }
    const activity = activityFromItem(
      item,
      method === "item/started" ? "started" : "completed",
      itemId,
    );
    if (activeThreadIsViewed && activity) {
      context.emit({
        type: "activity",
        threadId: active.threadId,
        turnId: active.turnId,
        item: activity,
      });
    }
    return;
  }

  if (method === "turn/completed") {
    const status = stringValue(turn?.status) ?? "completed";
    const error = recordValue(turn?.error);
    context.emit({
      type: "turn-completed",
      threadId: active.threadId,
      turnId: active.turnId,
      clientMessageId: active.clientMessageId,
      status,
      ...(stringValue(error?.message)
        ? { message: stringValue(error?.message) }
        : {}),
    });
    context.clearPendingApprovals(active.threadId);
    context.activeTurns.delete(active.threadId);
    if (active.threadId !== context.viewedThreadId) {
      void context.releaseThreadSubscription(
        active.threadId,
        "background-turn-completed",
      );
    }
    context.emit({ type: "sessions-changed" });
    return;
  }

  if (method === "error" && params.willRetry !== true) {
    const message = turnErrorMessage(params);
    context.emit({
      type: "error",
      threadId: active.threadId,
      message,
      clientMessageId: active.clientMessageId,
    });
    context.clearPendingApprovals(active.threadId);
    context.activeTurns.delete(active.threadId);
    if (active.threadId !== context.viewedThreadId) {
      void context.releaseThreadSubscription(
        active.threadId,
        "background-turn-failed",
      );
    }
  }
}

/** @param {Error} error */
export function handleCodexFailure(context: CodexChatEventContext, error: Error) {
  const activeTurns = [...context.activeTurns.values()];
  context.activeTurns.clear();
  context.pendingNewTurnClientMessageId = null;
  context.clearPendingApprovals();
  if (activeTurns.length === 0) {
    context.emit({ type: "error", message: errorMessage(error) });
    return;
  }
  for (const active of activeTurns) {
    context.emit({
      type: "error",
      threadId: active.threadId,
      message: errorMessage(error),
      clientMessageId: active.clientMessageId,
    });
  }
}

/**
 * @param {string} threadId
 * @param {string} clientMessageId
 * @returns {ActiveTurn}
 */
export function beginCodexTurn(context: CodexChatEventContext, threadId: string, clientMessageId: string): ActiveTurn {
  if (context.activeTurns.has(threadId))
    throw new Error("A response is already in progress for this chat.");
  /** @type {ActiveTurn} */
  const active: ActiveTurn = {
    threadId,
    turnId: null,
    clientMessageId,
    deltaItemIds: new Set(),
    commands: new Map(),
    interruptRequested: false,
    startedEmitted: false,
  };
  context.activeTurns.set(threadId, active);
  return active;
}

/**
 * @param {string | null} threadId
 * @param {string} clientMessageId
 * @param {unknown} error
 */
export function failCodexCommand(context: CodexChatEventContext, threadId: string | null, clientMessageId: string, error: unknown) {
  const active = threadId ? context.activeTurns.get(threadId) : null;
  if (threadId && active?.clientMessageId === clientMessageId)
    context.activeTurns.delete(threadId);
  context.emit({
    type: "error",
    message: errorMessage(error),
    clientMessageId,
    ...(threadId ? { threadId } : {}),
  });
}
