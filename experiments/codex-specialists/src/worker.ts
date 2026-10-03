import { timingSafeEqual } from 'node:crypto';
import { parseRuntimeConfiguration } from './runtime-config.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { SpecialistAgent, TaskConflict } from './agent.ts';
import { AppServerClient } from './app-server-client.ts';
import { record, textValue } from './protocol.ts';
import { AgentStore, validateTaskId } from './store.ts';
import { WorkerCollaboration } from './collaboration.ts';
import { WorkerHistory } from './history.ts';
import { WorkerHistoryQueue } from './history-queue.ts';

const workspace = process.env.AGENT_WORKSPACE ?? '/workspace';
const store = new AgentStore(process.env.AGENT_DATA_DIRECTORY ?? '/agent');
const configurationPath = process.env.AGENT_RUNTIME_CONFIG;
if (configurationPath) {
  while (!existsSync(configurationPath) || JSON.parse(readFileSync(configurationPath, 'utf8')).revision !== process.env.AGENT_RUNTIME_REVISION) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const configuration = configurationPath ? parseRuntimeConfiguration(JSON.parse(readFileSync(configurationPath, 'utf8'))) : undefined;
const profile = configuration?.instructions ?? readFileSync(process.env.AGENT_PROFILE ?? '/app/profiles/verifier/AGENTS.md', 'utf8');
const client = new AppServerClient();
await client.initialize();
let transportError: string | null = null;
client.onFailure(error => { transportError = error.message; });
const collaboration = configuration ? new WorkerCollaboration(store, configuration.profileId, workspace) : undefined;
const history = new WorkerHistory(store, client, process.env.AGENT_DATA_DIRECTORY ?? '/agent', workspace);
const historyQueue = configuration ? new WorkerHistoryQueue(process.env.AGENT_DATA_DIRECTORY ?? '/agent') : undefined;
const agent = new SpecialistAgent({ client, store, workspace, profile, configuration, collaboration, history, historyQueue });
const pump = setInterval(() => {
  try { agent.pump(); } catch { transportError = 'Could not persist collaboration state.'; }
}, 1000);
const port = Number(process.env.AGENT_PORT ?? 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid agent port.');

const server = Bun.serve({
  hostname: '0.0.0.0', port,
  async fetch(request) {
    if (request.headers.has('origin')) return Response.json({ error: 'Browser-origin requests are disabled.' }, { status: 403 });
    const path = new URL(request.url).pathname;
    if (configuration && request.method !== 'GET') {
      const actual = Buffer.from(request.headers.get('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${configuration.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    try {
      const error = transportError ?? agent.error;
      if (path === '/collaboration/exchange' && request.method === 'POST' && collaboration) {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new TypeError('Use application/json.');
        const body = await request.text();
        if (body.length > 2 * 1024 * 1024) throw new TypeError('Request is too large.');
        return Response.json(collaboration.exchange(JSON.parse(body)));
      }
      if (path.startsWith('/history/') && request.method === 'POST' && configuration) {
        const body = await request.text();
        if (body.length > 2 * 1024 * 1024) throw new TypeError('Request is too large.');
        const input = JSON.parse(body);
        if (path === '/history/exchange') return Response.json(historyQueue!.exchange(input));
        if (path === '/history/catalog') return Response.json(history.catalog());
        if (path === '/history/read') return Response.json(await history.read(input));
      }
      if (path === '/health' && request.method === 'GET') {
        return Response.json({ ready: error === null, role: configuration?.role ?? 'verifier', busy: agent.busy,
          threadId: store.snapshot().threadId, deniedRequests: client.deniedRequests, error },
        { status: error === null ? 200 : 503 });
      }
      if (error) return Response.json({ error }, { status: 503 });
      if (path === '/account' && request.method === 'GET') {
        const result = await client.request('account/read', { refreshToken: false });
        const account = result.account == null ? null : record(result.account);
        return Response.json({ authenticated: account?.type === 'chatgpt', type: account?.type ?? null, planType: account?.planType ?? null });
      }
      if (path === '/models' && request.method === 'GET') {
        const result = await client.request('model/list', { limit: 100 });
        return Response.json({ data: result.data, nextCursor: result.nextCursor });
      }
      if (path === '/activity' && request.method === 'GET') return Response.json(store.snapshot());
      if (path === '/tasks' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new TypeError('Use application/json.');
        const body = await request.text();
        if (body.length > 25_000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        const task = agent.submit(input.id === undefined ? randomUUID() : validateTaskId(input.id), textValue(input.prompt, 'prompt'));
        return Response.json(task, { status: 202 });
      }
      const match = /^\/tasks\/([a-zA-Z0-9_-]{1,80})(\/stop)?$/.exec(path);
      if (match?.[1]) {
        const id = match[1];
        if (!store.task(id)) return Response.json({ error: 'Unknown task.' }, { status: 404 });
        if (request.method === 'GET' && !match[2]) return Response.json(store.task(id));
        if (request.method === 'POST' && match[2]) {
          await agent.stop(id); return Response.json({ id, stopRequested: true }, { status: 202 });
        }
      }
      return Response.json({ error: 'Unknown route.' }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof TaskConflict ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 502 });
    }
  },
});

console.log(JSON.stringify({ type: 'ready', role: configuration?.role ?? 'verifier', port, workspace, persistedThread: store.snapshot().threadId }));
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(pump);
  server.stop(true);
  const tasks = store.snapshot().tasks.filter(task => ['accepted', 'running'].includes(task.status));
  await Promise.allSettled(tasks.map(task => agent.stop(task.id)));
  await client.close();
  await agent.settled();
  process.exit(0);
};
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
