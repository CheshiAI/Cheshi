import { setTimeout as delay } from 'node:timers/promises';
import { mcpServersFromListResponse } from './codex-chat-catalog.mts';
import type { ChatMcpServer, CodexChatClient, CodexChatLogger } from './codex-chat-types.mts';
import { errorMessage, requiredString } from './codex-chat-values.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

interface McpProbeContext {
  createMcpProbeClient?: () => CodexMcpProbeClient;
  cwd: string;
  log: CodexChatLogger;
}

export type CodexMcpProbeClient = Pick<CodexChatClient, 'request'> & { stop(): Promise<void> };
interface PendingProbe {
  result: Promise<{ servers: ChatMcpServer[] }>;
  close(): Promise<void>;
}
const pendingProbes = new WeakMap<McpProbeContext, PendingProbe>();
const STARTUP_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

function assertEphemeral(value: unknown): void {
  if (value !== true) throw new Error('Codex did not confirm a temporary MCP diagnostic thread.');
}

function assertProbeOpen(closed: boolean): void {
  if (closed) throw new Error('Temporary MCP diagnostic canceled.');
}

export function stopCodexMcpProbe(context: McpProbeContext): Promise<void> {
  return pendingProbes.get(context)?.close() ?? Promise.resolve();
}

/** Discover live connections without selecting a chat, saving history, or starting a model turn. */
export async function probeCodexMcpServers(context: McpProbeContext): Promise<{ servers: ChatMcpServer[] }> {
  const pending = pendingProbes.get(context);
  if (pending) return pending.result;
  if (!context.createMcpProbeClient) throw new Error('Temporary MCP diagnostics are not configured.');
  const client = context.createMcpProbeClient();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed = true;
    return closing ??= Promise.resolve().then(() => client.stop());
  };
  const operation = runProbe(context, client, () => closed, close);
  pendingProbes.set(context, { result: operation, close });
  try {
    return await operation;
  } finally {
    pendingProbes.delete(context);
  }
}

async function runProbe(
  context: McpProbeContext,
  client: CodexMcpProbeClient,
  closed: () => boolean,
  close: () => Promise<void>,
): Promise<{ servers: ChatMcpServer[] }> {
  let failed = false;
  try {
    const response = recordValue(await client.request('thread/start', {
      cwd: context.cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    }));
    assertProbeOpen(closed());
    const thread = recordValue(response?.thread);
    const threadId = requiredString(stringValue(thread?.id), 'Temporary MCP diagnostic thread id');
    assertEphemeral(thread?.ephemeral);

    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (true) {
      assertProbeOpen(closed());
      const raw = await client.request('mcpServerStatus/list', {
        limit: 100, detail: 'toolsAndAuthOnly', threadId,
      });
      assertProbeOpen(closed());
      const servers = mcpServersFromListResponse(raw);
      const starting = servers.some(server => server.runtimeStatus === 'starting' || server.runtimeStatus === 'notStarted');
      if (!starting || Date.now() >= deadline) return { servers };
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      // Unsubscribe alone leaves ephemeral runtimes loaded in Codex 0.154.0.
      await close();
    } catch (error) {
      context.log('codex-mcp-probe-cleanup-failed', { message: errorMessage(error) });
      // Preserve the original diagnostic error when both operations fail.
      if (!failed) throw error;
    }
  }
}
