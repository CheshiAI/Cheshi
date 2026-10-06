import { WorkerChangeStream } from './change-stream.ts';
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
import { IdleLifecycle, WorkerSleepingError } from './idle-lifecycle.ts';

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
const client = new AppServerClient(undefined, undefined, undefined, configuration?.projectDocMaxBytes);
await client.initialize();
let transportError: string | null = null;
client.onFailure(error => { transportError = error.message; });
const collaboration = configuration ? new WorkerCollaboration(store, configuration.profileId, workspace) : undefined;
const history = new WorkerHistory(store, client, process.env.AGENT_DATA_DIRECTORY ?? '/agent', workspace);
const historyQueue = configuration ? new WorkerHistoryQueue(process.env.AGENT_DATA_DIRECTORY ?? '/agent') : undefined;
const agent = new SpecialistAgent({ client, store, workspace, profile, configuration, collaboration, history, historyQueue });
const lifecycle = new IdleLifecycle({ store, client, blocked: () => agent.busy || !!agent.error || !!transportError
  || collaboration?.next() != null || historyQueue?.pending === true });
const changes = new WorkerChangeStream();
let pumping = false, expiry: ReturnType<typeof setTimeout> | undefined;
const schedulePump = () => {
  if (pumping) return;
  pumping = true;
  queueMicrotask(() => {
    pumping = false;
    if (lifecycle.draining) return;
    try { agent.pump(); } catch { transportError = 'Could not persist collaboration state.'; changes.changed(); }
    clearTimeout(expiry);
    const deadline = lifecycle.probe().nextWakeAt;
    if (deadline !== null) expiry = setTimeout(schedulePump, Math.max(1, Math.min(2_147_483_647, deadline - Date.now())));
  });
};
store.subscribe(() => { changes.changed(); schedulePump(); });
historyQueue?.subscribe(() => changes.changed());
client.onFailure(() => changes.changed());
const health = setInterval(() => { if (!lifecycle.draining) void agent.checkHealth(); }, 120_000);
schedulePump();
const port = Number(process.env.AGENT_PORT ?? 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid agent port.');

const server = Bun.serve({
  hostname: '0.0.0.0', port, idleTimeout: 255,
  async fetch(request) {
    if (request.headers.has('origin')) return Response.json({ error: 'Browser-origin requests are disabled.' }, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === '/events' && configuration) return changes.handle(request, configuration.token);
    if (configuration && request.method !== 'GET') {
      const actual = Buffer.from(request.headers.get('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${configuration.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    let leave: (() => void) | undefined;
    try {
      if (path.startsWith('/lifecycle/') && request.method === 'POST' && configuration) {
        if (path === '/lifecycle/status') return Response.json(lifecycle.probe());
        if (path === '/lifecycle/prepare') return Response.json(await lifecycle.prepare());
        if (path === '/lifecycle/resume') { lifecycle.cancel(); schedulePump(); return Response.json({ resumed: true }); }
        if (path === '/lifecycle/commit') {
          const body = await request.text();
          if (body.length > 1000) throw new TypeError('Request is too large.');
          await lifecycle.commit(JSON.parse(body));
          setTimeout(() => { void shutdown(true); }, 50);
          return Response.json({ committed: true });
        }
      }
      if (request.method !== 'GET') leave = lifecycle.enter();
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
        return Response.json({ chatsProtocol: 1, ready: error === null, role: configuration?.role ?? 'verifier', busy: agent.busy,
          threadId: store.snapshot().threadId, execution: agent.executionHealth, deniedRequests: client.deniedRequests, error },
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
      if (path === '/activity' && request.method === 'GET') {
        if (!lifecycle.draining) collaboration?.expire();
        return Response.json({ ...agent.activity(), ...(historyQueue ? { recall: historyQueue.inspection() } : {}) });
      }
      if (path === '/tasks' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new TypeError('Use application/json.');
        const body = await request.text();
        if (body.length > 25_000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        const task = agent.submit(input.id === undefined ? randomUUID() : validateTaskId(input.id), textValue(input.prompt, 'prompt'), input.chat === undefined ? undefined : (() => { const c = record(input.chat); if (typeof c.goal !== 'boolean' || (c.automatic !== undefined && c.automatic !== true)) throw new TypeError('Invalid chat goal.'); return { roomId: validateTaskId(c.roomId), conversation: validateTaskId(c.conversation), goal: c.goal, ...(c.automatic === true ? { automatic: true as const, userText: textValue(c.userText, 'user message') } : {}) }; })());
        return Response.json(task, { status: 202 });
      }
      const permission = /^\/tasks\/([a-zA-Z0-9_-]{1,80})\/permissions$/.exec(path);
      if (permission && request.method === 'POST') {
        const body = await request.text();
        if (body.length > 1000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        if (input.decision !== 'allow' && input.decision !== 'deny') throw new TypeError('Invalid permission decision.');
        return Response.json(agent.resolvePermissions(permission[1]!, validateTaskId(input.roomId), validateTaskId(input.requestId), input.decision));
      }
      const question = /^\/tasks\/([a-zA-Z0-9_-]{1,80})\/(question|question-deadline)$/.exec(path);
      if (question && request.method === 'POST') {
        const body = await request.text();
        if (body.length > 1000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        if (question[2] === 'question-deadline') return Response.json(agent.questionDeadline(question[1]!,
          validateTaskId(input.roomId), validateTaskId(input.questionId), input.expiresAt));
        return Response.json(agent.question(question[1]!, validateTaskId(input.roomId), validateTaskId(input.questionId),
          input.recipient === null ? null : validateTaskId(input.recipient)));
      }
      const resume = /^\/tasks\/([a-zA-Z0-9_-]{1,80})\/input$/.exec(path);
      const application = /^\/tasks\/([a-zA-Z0-9_-]{1,80})\/application$/.exec(path);
      if (application && request.method === 'POST') {
        const body = await request.text();
        if (body.length > 1000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        return Response.json(agent.inspectApplication(application[1]!, validateTaskId(input.roomId),
          textValue(input.candidateId, 'candidate'), textValue(input.hash, 'hash')));
      }
      const recovery = /^\/tasks\/([a-zA-Z0-9_-]{1,80})\/recover$/.exec(path);
      if (recovery && request.method === 'POST') {
        const body = await request.text();
        if (body.length > 1000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        return Response.json(await agent.recover(recovery[1]!, validateTaskId(input.roomId)));
      }
      if (resume && request.method === 'POST') {
        const body = await request.text();
        if (body.length > 25_000) throw new TypeError('Request is too large.');
        const input = record(JSON.parse(body));
        return Response.json(agent.input(resume[1]!, validateTaskId(input.id), textValue(input.prompt, 'prompt'), validateTaskId(input.roomId), input.questionId === undefined ? undefined : validateTaskId(input.questionId)), { status: 202 });
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
        { status: error instanceof TaskConflict || error instanceof WorkerSleepingError ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 502 });
    } finally { leave?.(); }
  },
});

console.log(JSON.stringify({ type: 'ready', role: configuration?.role ?? 'verifier', port, workspace, persistedThread: store.snapshot().threadId }));
let stopping = false;
const shutdown = async (sleep = false) => {
  if (stopping) return;
  stopping = true;
  clearInterval(health); clearTimeout(expiry); changes.dispose();
  server.stop(true);
  const tasks = store.snapshot().tasks.filter(task => ['accepted', 'running'].includes(task.status));
  if (!sleep) await Promise.allSettled(tasks.map(task => agent.stop(task.id)));
  await client.close();
  await agent.settled();
  agent.disposeScratch();
  process.exit(0);
};
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
