import type { CodexChatClient, CodexChatLogger, JsonObject } from './codex-chat-types.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

const SERVER_NAME = 'cheshi_codegraph';
const RETRY_INTERVAL_MS = 30_000;
const recoveries = new WeakMap<CodexChatClient, ReturnType<typeof createCodexMcpRecovery>>();

function transportFailure(value: unknown): boolean {
  const text = stringValue(value);
  return text !== null && /transport closed|connection (?:closed|reset)|broken pipe|unexpected eof/i.test(text);
}

function failedConnection(value: unknown): boolean {
  const server = recordValue(value);
  if (server?.name !== SERVER_NAME) return false;
  if (server.runtimeStatus === 'cancelled') return true;
  if (server.runtimeStatus !== 'failed' || server.failureReason === 'reauthenticationRequired') return false;
  const error = stringValue(server.error) ?? stringValue(server.toolsError);
  return !error || transportFailure(error);
}

/** One coordinator per transport, shared by all chat panes using that Codex client. */
export function codexMcpRecovery(client: CodexChatClient, log: CodexChatLogger) {
  let recovery = recoveries.get(client);
  if (!recovery) { recovery = createCodexMcpRecovery(client, log); recoveries.set(client, recovery); }
  return recovery;
}

export function createCodexMcpRecovery(
  client: Pick<CodexChatClient, 'request'>,
  log: CodexChatLogger,
  now = Date.now,
) {
  let flight: Promise<boolean> | null = null;
  let lastAttempt: number | null = null;
  const readFlights = new Map<string, Promise<unknown>>();
  const status = (threadId: string) => client.request('mcpServerStatus/list', {
    threadId, limit: 100, detail: 'toolsAndAuthOnly',
  }, 10_000);

  function reload(threadId: string): Promise<boolean> {
    if (flight) return flight;
    if (lastAttempt !== null && now() - lastAttempt < RETRY_INTERVAL_MS) return Promise.resolve(false);
    lastAttempt = now();
    flight = Promise.resolve().then(async () => {
      try {
        // Codex refreshes loaded runtimes; no configuration writes or model turns are needed.
        await client.request('config/mcpServer/reload', undefined, 30_000);
        log('codex-mcp-reload-requested', { threadId, server: SERVER_NAME });
        return true;
      } catch (error) {
        log('codex-mcp-reload-failed', { threadId, server: SERVER_NAME,
          message: error instanceof Error ? error.message : String(error) });
        return false;
      } finally { flight = null; }
    });
    return flight;
  }

  function read(threadId: string): Promise<unknown> {
    const pending = readFlights.get(threadId);
    if (pending) return pending;
    const result = Promise.resolve().then(async () => {
      // Wait for an already requested refresh before exposing a possibly stale status.
      if (flight) await flight;
      const response = await status(threadId);
      const data = recordValue(response)?.data;
      if (Array.isArray(data) && data.some(failedConnection) && await reload(threadId)) return status(threadId);
      return response;
    }).finally(() => { readFlights.delete(threadId); });
    readFlights.set(threadId, result);
    return result;
  }

  return {
    read,
    async prepare(threadId: string) {
      try { await read(threadId); }
      catch (error) {
        // MCP diagnostics must not discard an otherwise valid user message.
        log('codex-mcp-health-check-failed', { threadId,
          message: error instanceof Error ? error.message : String(error) });
      }
    },
    observe(value: JsonObject) {
      const params = recordValue(value.params);
      const threadId = stringValue(params?.threadId);
      if (!params || !threadId) return;
      if (value.method === 'mcpServer/startupStatus/updated' && params.name === SERVER_NAME
        && params.status === 'failed' && transportFailure(params.error)) {
        void reload(threadId);
      }
      if (value.method !== 'item/completed') return;
      const item = recordValue(params.item);
      if (item?.type !== 'mcpToolCall' || item.server !== SERVER_NAME) return;
      const error = recordValue(item.error);
      const result = recordValue(item.result);
      const content = Array.isArray(result?.content) ? result.content : [];
      if (transportFailure(error?.message) || (result?.isError === true
        && content.some(part => transportFailure(recordValue(part)?.text)))) void reload(threadId);
    },
  };
}
