import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HISTORY_MCP_NAME, HISTORY_TOOLS, callHistoryTool } from './codex-chat-history-tools.mts';
import type { ChatHistoryRecall } from './chat-history-recall.mts';
import { recordValue } from './codex-service-utils.mts';

type Command = { environment?: NodeJS.ProcessEnv };
const TOKEN_ENV = 'CHESHI_HISTORY_MCP_TOKEN';
const PROTOCOL = '2025-11-25';
type Session = { requests: Map<string | number, AbortController> };

function respond(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16_384) throw new Error('Request too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Workspace-local, authenticated MCP bridge. No authored configuration or user credential is persisted. */
export function createWorkspaceHistoryMcp(recall: Pick<ChatHistoryRecall, 'search' | 'read'>) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const lifetime = new AbortController();
  const sessions = new Map<string, Session>();
  let pending: Promise<string> | undefined;
  let endpoint: URL | undefined;
  let runningCalls = 0;
  const cancel = (session: Session) => { for (const request of session.requests.values()) request.abort(); };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) respond(response, 400, { error: 'Invalid history MCP request.' });
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (!endpoint || request.headers.host !== endpoint.host || request.url !== '/mcp'
      || request.headers.origin !== undefined || supplied.length !== authorization.length
      || !timingSafeEqual(supplied, authorization)) { respond(response, 403); return; }
    const sessionId = request.headers['mcp-session-id'];
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (request.method === 'DELETE') {
      if (session && typeof sessionId === 'string') { cancel(session); sessions.delete(sessionId); }
      respond(response, session ? 200 : 404); return;
    }
    if (request.method !== 'POST') { respond(response, 405); return; }
    if (!request.headers['content-type']?.startsWith('application/json')) { respond(response, 415); return; }
    const message = recordValue(await body(request));
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { respond(response, 400); return; }
    const id = message.id;
    const params = recordValue(message.params);
    if (id === undefined) {
      if (!session) { respond(response, 404); return; }
      const target = params?.requestId;
      if (message.method === 'notifications/cancelled' && (typeof target === 'string' || typeof target === 'number')) {
        session.requests.get(target)?.abort();
      }
      respond(response, 202); return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') { respond(response, 400); return; }
    const result = (value: unknown) => respond(response, 200, { jsonrpc: '2.0', id, result: value });
    if (message.method === 'initialize') {
      if (sessions.size >= 256) { respond(response, 503); return; }
      const created = randomUUID();
      sessions.set(created, { requests: new Map() });
      response.setHeader('Mcp-Session-Id', created);
      const requested = params?.protocolVersion;
      result({ protocolVersion: ['2025-06-18', PROTOCOL].includes(String(requested)) ? requested : PROTOCOL,
        capabilities: { tools: {} }, serverInfo: { name: HISTORY_MCP_NAME, version: '1.0.0' } });
      return;
    }
    if (!session) { respond(response, 404); return; }
    if (message.method === 'ping') { result({}); return; }
    if (message.method === 'tools/list') { result({ tools: HISTORY_TOOLS }); return; }
    if (message.method !== 'tools/call') {
      respond(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } }); return;
    }
    if (runningCalls >= 4 || session.requests.has(id)) { respond(response, 429); return; }
    const controller = new AbortController();
    session.requests.set(id, controller);
    runningCalls++;
    try {
      const signal = AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(55_000)]);
      const value = await callHistoryTool(recall, params?.name, params?.arguments, signal);
      signal.throwIfAborted();
      result({ ...(recordValue(value)?.status === 'error' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] });
    } catch (error) {
      result({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'History search failed.' }] });
    } finally { session.requests.delete(id); runningCalls--; }
  }

  const start = (): Promise<string> => {
    lifetime.signal.throwIfAborted();
    pending ??= new Promise<string>((resolve, reject) => {
      const failure = () => { pending = undefined; reject(new Error('Could not start the local history search connection.')); };
      server.once('error', failure);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', failure);
        const address = server.address();
        if (!address || typeof address === 'string') { failure(); return; }
        endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
        resolve(endpoint.href);
      });
    });
    return pending;
  };

  return {
    async prepareCommand(command: Command): Promise<string[]> {
      const url = await start();
      lifetime.signal.throwIfAborted();
      command.environment = { ...command.environment, [TOKEN_ENV]: token };
      return Object.entries({ url: JSON.stringify(url), bearer_token_env_var: JSON.stringify(TOKEN_ENV),
        enabled: 'true', tool_timeout_sec: '60' }).flatMap(([key, value]) => ['-c', `mcp_servers.${HISTORY_MCP_NAME}.${key}=${value}`]);
    },
    async stop() {
      lifetime.abort();
      for (const session of sessions.values()) cancel(session);
      sessions.clear();
      await pending?.catch(() => {});
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
