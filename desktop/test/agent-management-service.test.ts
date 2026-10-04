import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createAgentManagementService, readWorker } from '../lib/agent-management/service.mts';
import type { AgentEngine, RuntimeAgent } from '../lib/agent-management/engine.mts';
import { agentRecord, parseAgentDetails, parseAgentSnapshot } from '../shared/agent-management.ts';
import { parseAgentExecutionHealth } from '../shared/agent-execution-health.ts';

const agent: RuntimeAgent = { id: 'worker', name: 'Verifier', image: 'verifier:test', state: 'running', endpoint: 'http://127.0.0.1:47832' };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function rejected(operation: Promise<unknown>, text: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(text);
}
function fixture() {
  let busy: unknown = false, online = true;
  let execution: unknown = undefined;
  const actions: string[] = [];
  let gate: Promise<void> | null = null;
  const engine: AgentEngine = {
    kind: 'test', engines: async () => [{ id: 'test:local', name: 'Test', supported: true, reason: null }],
    list: async () => { if (!online) throw new Error('offline'); return [agent]; },
    inspect: async () => agent,
    control: async (_engine, _id, action) => { actions.push(action); if (gate) await gate; },
    logs: async () => 'ready',
  };
  const service = createAgentManagementService({ engines: [engine], read: async (_endpoint, path) => {
    if (path === '/health') return { role: 'verifier', ready: true, busy, threadId: 'thread-1', error: null, execution };
    if (path === '/account') return { authenticated: true, access_token: 'must-not-leave-main' };
    return { tasks: [{ id: 'task-1', prompt: 'review', status: 'completed', createdAt: '2026-10-02', output: 'done', error: null }] };
  } });
  return { service, actions, busy: (value: unknown) => { busy = value; }, offline: () => { online = false; },
    hold: (value: Promise<void>) => { gate = value; }, execution: (value: unknown) => { execution = value; } };
}

test('live execution health crosses the service and IPC boundary without changing task status', async () => {
  const f = fixture(), execution = { taskId: 'task-1', startedAt: '2026-10-04T00:00:00Z',
    lastActivityAt: '2026-10-04T00:01:00Z', lastActivity: 'tool', checkedAt: '2026-10-04T00:02:00Z',
    lastResponsiveAt: '2026-10-04T00:01:45Z', engineStatus: 'unconfirmed' } as const;
  f.execution({ ...execution, privateOutput: 'must-not-leave-main' }); f.busy(true);
  const details = parseAgentDetails(await f.service.details('test:local', 'worker'));
  expect(details.execution).toEqual(execution); expect(details.busy).toBe(true); expect(details.ready).toBe(true);
  expect(details.tasks[0]?.status).toBe('completed');
  f.execution(null); expect(parseAgentDetails(await f.service.details('test:local', 'worker')).execution).toBeNull();
  for (const invalid of [{ ...execution, lastActivityAt: 'invalid' }, { ...execution, engineStatus: true }, { ...execution, taskId: '' }]) {
    expect(() => parseAgentExecutionHealth(invalid)).toThrow();
  }
});

test('engine-independent service reports offline and projects only account status', async () => {
  const f = fixture();
  expect((await f.service.engines()).engines[0]?.id).toBe('test:local');
  const details = parseAgentDetails(await f.service.details('test:local', 'worker'));
  expect(details.authenticated).toBe(true);
  expect(details.threadId).toBe('thread-1');
  expect(details.tasks[0]?.output).toBe('done');
  expect(JSON.stringify(details)).not.toContain('must-not-leave-main');
  f.offline();
  expect(parseAgentSnapshot(await f.service.snapshot('test:local')).online).toBe(false);
});

test('busy or malformed health prevents stop/restart before any engine mutation', async () => {
  const f = fixture();
  f.busy(true);
  await rejected(f.service.control('test:local', 'worker', 'stop'), 'worker is busy');
  f.busy('false');
  await rejected(f.service.control('test:local', 'worker', 'restart'), 'Cannot verify');
  expect(f.actions).toEqual([]);
  f.busy(false);
  await f.service.control('test:local', 'worker', 'restart');
  expect(f.actions).toEqual(['restart']);
});

test('serializes control across workspace windows and releases the lock after acknowledgment', async () => {
  const f = fixture(), gate = createDeferred<void>();
  f.hold(gate.promise);
  const first = f.service.control('test:local', 'worker', 'restart');
  await rejected(f.service.control('test:local', 'worker', 'stop'), 'already running');
  gate.resolve(); await first;
  await f.service.control('test:local', 'worker', 'stop');
  expect(f.actions).toEqual(['restart', 'stop']);
});

test('HTTP inspection rejects remote endpoints, redirects and oversized responses', async () => {
  await rejected(readWorker('http://example.com:80', '/health'), 'loopback');
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(302, { location: '/account' }); response.end(); }
    else if (request.url === '/activity') response.end('x'.repeat(2 * 1024 * 1024 + 1));
    else response.end(JSON.stringify({ authenticated: true }));
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const endpoint = `http://127.0.0.1:${address.port}`;
    expect(agentRecord(await readWorker(endpoint, '/account')).authenticated).toBe(true);
    let redirectFailed = false;
    try { await readWorker(endpoint, '/health'); } catch { redirectFailed = true; }
    expect(redirectFailed).toBe(true);
    await rejected(readWorker(endpoint, '/activity'), 'inspection limit');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); }); }
});
