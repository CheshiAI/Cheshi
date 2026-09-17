import { setTimeout as delay } from 'node:timers/promises';
import type { CodexChatClient, CodexChatLogger } from './codex-chat-types.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';
import { WORKSPACE_CODEGRAPH_MCP_NAME } from './workspace-codegraph-mcp.mts';

interface RecoveryContext {
  client: CodexChatClient;
  activeTurns: ReadonlyMap<string, unknown>;
  log: CodexChatLogger;
}

const turnStartGates = new WeakMap<CodexChatClient, Promise<void>>();
const RECOVERY_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('MCP recovery timed out.');
  return remaining;
}

async function codeGraphStatus(client: CodexChatClient, threadId: string, deadline: number, signal: AbortSignal) {
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const raw = recordValue(await client.request('mcpServerStatus/list', {
      threadId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}),
    }, remainingTime(deadline)));
    signal.throwIfAborted();
    const server = Array.isArray(raw?.data)
      ? raw.data.map(recordValue).find(value => value?.name === WORKSPACE_CODEGRAPH_MCP_NAME)
      : undefined;
    if (server) return stringValue(server.runtimeStatus);
    cursor = stringValue(raw?.nextCursor) || undefined;
  } while (cursor);
  return null;
}

async function recoverCodeGraph(context: RecoveryContext, threadId: string, signal: AbortSignal): Promise<void> {
  // Reload refreshes all loaded threads in this app-server, so never interrupt an active turn.
  if (context.activeTurns.size > 0) return;
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  let phase = 'status';
  try {
    const status = await codeGraphStatus(context.client, threadId, deadline, signal);
    if (status !== 'failed' || context.activeTurns.size > 0) return;
    phase = 'reload';
    context.log('codex-mcp-recovery-started', { threadId, server: WORKSPACE_CODEGRAPH_MCP_NAME });
    signal.throwIfAborted();
    await context.client.request('config/mcpServer/reload', null, remainingTime(deadline));
    signal.throwIfAborted();
    phase = 'ready';
    while (true) {
      const current = await codeGraphStatus(context.client, threadId, deadline, signal);
      if (current === 'connected') {
        context.log('codex-mcp-recovery-completed', { threadId, server: WORKSPACE_CODEGRAPH_MCP_NAME });
        return;
      }
      // A queued reload can briefly leave the old failed status visible.
      if (current !== 'failed' && current !== 'starting' && current !== 'notStarted') {
        context.log('codex-mcp-recovery-unavailable', { threadId, phase, status: current });
        return;
      }
      await delay(Math.min(POLL_INTERVAL_MS, remainingTime(deadline)), undefined, { signal });
    }
  } catch {
    signal.throwIfAborted();
    // Older servers and unavailable MCP must not prevent ordinary chat. Never log provider payloads.
    context.log('codex-mcp-recovery-unavailable', { threadId, phase });
  }
}

async function acquireTurnStartLock(
  context: RecoveryContext,
  signal: AbortSignal,
): Promise<() => void> {
  const previous = turnStartGates.get(context.client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  turnStartGates.set(context.client, gate);
  await previous;
  const unlock = () => {
    if (turnStartGates.get(context.client) === gate) turnStartGates.delete(context.client);
    release();
  };
  try {
    signal.throwIfAborted();
    return unlock;
  } catch (error) {
    unlock();
    throw error;
  }
}

/** Hold this lease until turn/start is acknowledged, including when recovery is unnecessary. */
export async function acquireCodexMcpTurnStart(
  context: RecoveryContext, threadId: string, signal: AbortSignal,
): Promise<() => void> {
  const release = await acquireTurnStartLock(context, signal);
  try {
    await recoverCodeGraph(context, threadId, signal);
    signal.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** Review and compact commands share the gate so they cannot start during a reload. */
export async function withCodexMcpTurnStartLock<T>(
  context: RecoveryContext, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const release = await acquireTurnStartLock(context, signal);
  try { return await operation(signal); } finally { release(); }
}
