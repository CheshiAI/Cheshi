import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createAgentManagementService, readWorker } from '../lib/agent-management/service.mts';
import type { AgentEngine, RuntimeAgent } from '../lib/agent-management/engine.mts';
import { agentRecord, parseAgentDetails, parseAgentSnapshot } from '../shared/agent-management.ts';

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
    if (path === '/health') return { role: 'verifier', ready: true, busy, threadId: 'thread-1', error: null };
    if (path === '/account') return { authenticated: true, access_token: 'must-not-leave-main' };
    return { tasks: [{ id: 'task-1', prompt: 'review', status: 'completed', createdAt: '2026-10-02', output: 'done', error: null }] };
  } });
  return { service, actions, busy: (value: unknown) => { busy = value; }, offline: () => { online = false; },
    hold: (value: Promise<void>) => { gate = value; } };
}

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
