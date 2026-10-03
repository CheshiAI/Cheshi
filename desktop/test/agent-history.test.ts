import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHistory, type HistoryTransport } from '../lib/agent-orchestration/history-source.mts';
import { AgentHistoryRelay } from '../lib/agent-orchestration/history-relay.mts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
import { WorkerHistory } from '../../experiments/codex-specialists/src/history.ts';
import { WorkerHistoryQueue } from '../../experiments/codex-specialists/src/history-queue.ts';
import { createDeferred, record } from '../../experiments/codex-specialists/src/protocol.ts';
import type { RpcClient } from '../../experiments/codex-specialists/src/app-server-client.ts';
import type { RecallEvaluator } from '../lib/chat-history-recall-model.mts';

const dirs: string[] = [];
function temporary() { const d = mkdtempSync(join(tmpdir(), 'cheshi-history-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const connection = { endpoint: 'http://127.0.0.1:9876', token: 'fixture' };
const binding = bindingFor('/project', 'docker:fixture', 'dev', 'account');
async function failure(promise: Promise<unknown>, message: string) {
  let error: unknown; try { await promise; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
function native(id: string, text: string, cwd = '/workspace') {
  return { thread: { id, cwd, turns: [{ id: `turn-${id}`, items: [{ type: 'agentMessage', id: `item-${id}`, text }] }] } };
}
function fixture(evaluate?: RecallEvaluator) {
  const directory = temporary(), store = new AgentStore(directory), queue = new WorkerHistoryQueue(directory);
  const threads = new Map([['past', native('past', 'Login policy is HTTP 401 because credentials failed.')], ['current', native('current', 'New task.')]]);
  let calls = 0, enabled = true, valid = true;
  const listeners = new Set<() => void>();
  const transport: HistoryTransport = async (_connection, route, body) => {
    if (route === '/history/exchange') return queue.exchange(body);
    if (route === '/history/catalog') return { sessions: [...threads.keys()].map(id => ({ id, title: id, updatedAt: 1 })) };
    return threads.get(String(record(body).threadId));
  };
  const evaluator: RecallEvaluator = async (...args) => {
    calls++;
    return evaluate ? evaluate(...args) : args[1].map(c => ({ answer: c.text.includes('401') ? .95 : .01, related: .01, direct: .95 }));
  };
  const options = { enabled: () => enabled, getKey: () => null, transport, evaluate: evaluator,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const relay = () => new AgentHistoryRelay(join(directory, 'relay.json'), options);
  const search = (callId = 'call') => queue.call('task', 'current', 'turn-current', callId, 'history_search', { query: 'Login policy' }, signal());
  return { directory, store, queue, threads, transport, evaluator, relay, search, calls: () => calls,
    valid: () => valid, invalidate: () => { valid = false; }, disable: () => { enabled = false; listeners.forEach(l => l()); } };
}
async function flush() { await new Promise<void>(resolve => setTimeout(resolve, 0)); }
async function deliver(f: ReturnType<typeof fixture>, relay: AgentHistoryRelay) {
  await relay.tick(binding, connection, f.valid); await flush(); await relay.tick(binding, connection, f.valid);
}

test('scoped search returns originals and read ids; reuses judgments with incremental zero calls', async () => {
  const f = fixture(), source = createAgentHistory(connection, f.evaluator, f.transport);
  const first = await source.call('history_search', { query: 'Login policy' }, 'current', signal());
  expect(JSON.stringify(first.result)).toContain('HTTP 401');
  expect(Object.keys(first.proof)).toContain('past');
  const read = await source.call('history_read', { threadId: 'past', turnId: 'turn-past', itemId: 'item-past' }, 'current', signal());
  expect(record(read.result).text).toContain('HTTP 401');
  await source.call('history_search', { query: 'Login policy' }, 'current', signal());
  expect(f.calls()).toBe(1);
  f.threads.delete('past'); expect(await source.verify(first.proof, signal())).toBe(false);
});

test('cannot expand scope through thread ids, paths, account overrides or foreign cwd', async () => {
  const f = fixture(), source = createAgentHistory(connection, f.evaluator, f.transport);
  for (const args of [{ query: 'policy', threadId: 'foreign' }, { query: 'policy', accountId: 'other' }, { query: 'policy', path: '/secret' }]) {
    await failure(source.call('history_search', args, 'current', signal()), 'Unsupported');
  }
  await failure(source.call('history_search', { query: 'policy', focusThreadId: 'foreign' }, 'current', signal()), 'outside');
  await failure(source.call('history_read', { threadId: 'foreign' }, 'current', signal()), 'outside');
  await failure(source.call('history_search', { query: 'policy' }, 'foreign', signal()), 'outside');
  f.threads.set('past', native('past', 'FOREIGN_SECRET', '/other'));
  const result = await source.call('history_search', { query: 'FOREIGN_SECRET' }, 'current', signal());
  expect(JSON.stringify(result.result)).not.toContain('"text":"FOREIGN_SECRET"');
  expect(record(result.result).unavailableSessions).toContain('past');
});

test('worker projects authored input and assistant text while withholding generated envelopes, tools and instructions', async () => {
  const d = temporary(), store = new AgentStore(d); store.create('task', 'Original question'); store.saveThread('past', null, 'task');
  const raw = { thread: { id: 'past', cwd: '/workspace', turns: [
    { id: 'turn-a', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Saved work summary: OLD_SECRET\nCurrent task:\nOriginal question' }] },
      { id: 'a', type: 'agentMessage', text: 'Answer' }, { id: 't', type: 'dynamicToolCall', contentItems: [{ text: 'SECRET_TOOL' }] }] },
    { id: 'turn-b', items: [{ id: 'r', type: 'userMessage', content: [{ type: 'text', text: 'Generated resume envelope' }] }] },
  ] } };
  const client: RpcClient = { request: async () => raw, subscribe: () => () => {}, onFailure: () => () => {} };
  let history = new WorkerHistory(store, client, d, '/workspace'); history.remember('past', 'turn-a', 'Original question'); history.remember('past', 'turn-b', null);
  history = new WorkerHistory(store, client, d, '/workspace');
  const result = JSON.stringify(await history.read({ threadId: 'past' }));
  expect(result).toContain('Original question'); expect(result).toContain('Answer');
  for (const text of ['OLD_SECRET', 'SECRET_TOOL', 'Generated resume envelope']) expect(result).not.toContain(text);
  await failure(history.read({ threadId: 'foreign' }), 'outside');
});

test('relay round trip deduplicates a native call and returns persisted originals', async () => {
  const f = fixture(), relay = f.relay();
  const first = f.search(), second = f.search(); await deliver(f, relay);
  expect(await second).toEqual(await first); expect(JSON.stringify(await first)).toContain('HTTP 401'); expect(f.calls()).toBe(1);
  expect(await f.search()).toEqual(await first);
  expect(readFileSync(join(f.directory, 'state', 'history-requests.json'), 'utf8')).toContain('HTTP 401');
  await relay.dispose();
});

test('does not deliver cached originals after they are removed between evaluation and delivery', async () => {
  const f = fixture(), relay = f.relay(), pending = f.search();
  await relay.tick(binding, connection, f.valid); await flush(); f.threads.delete('past');
  await relay.tick(binding, connection, f.valid);
  expect(JSON.stringify(await pending)).not.toContain('HTTP 401');
  expect(record(await pending).status).toBe('error'); await relay.dispose();
});

test('disabling recall cancels in-flight evaluation and immediately withholds results', async () => {
  const started = createDeferred<void>();
  const f = fixture(async (_q, _c, signal) => {
    started.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const relay = f.relay(), pending = f.search(); await relay.tick(binding, connection, f.valid); await started.promise;
  f.disable(); await flush(); await relay.tick(binding, connection, f.valid);
  expect(record(await pending).status).toBe('unavailable'); expect(f.calls()).toBe(1); await relay.dispose();
});

test('disabled setting performs no provider request and rejects truthy substitutes', async () => {
  const f = fixture(); f.disable(); const relay = f.relay(), pending = f.search(); await deliver(f, relay);
  expect(record(await pending).status).toBe('unavailable'); expect(f.calls()).toBe(0); await relay.dispose();
  const second = f.search('second'); f.queue.exchange({ protocol: 1, enabled: 'true', results: [] });
  expect(record(await second).status).toBe('unavailable');
});

test('worker cancellation rejects late results and host restart never repeats an ambiguous paid search', async () => {
  const f = fixture(), controller = new AbortController();
  const canceled = f.queue.call('task', 'current', 'turn-current', 'cancel', 'history_search', { query: 'policy' }, controller.signal);
  const request = f.queue.exchange({ protocol: 1, enabled: true, results: [] }).requests[0]!;
  controller.abort(); expect(record(await canceled).status).toBe('error');
  f.queue.exchange({ protocol: 1, enabled: true, results: [{ id: request.id, result: { text: 'LATE' } }] });
  expect(JSON.stringify(await canceled)).not.toContain('LATE');
  const pending = f.search();
  const queued = f.queue.exchange({ protocol: 1, enabled: true, results: [] }).requests[0]!;
  const { createHash } = await import('node:crypto');
  const scope = createHash('sha256').update(JSON.stringify([binding, connection.token])).digest('hex');
  const { status: _status, ...input } = queued;
  writeFileSync(join(f.directory, 'relay.json'), JSON.stringify([{ scope, request: input, status: 'running' }]));
  const relay = f.relay(); await relay.tick(binding, connection, f.valid);
  expect(record(await pending).error).toContain('Host restarted'); expect(f.calls()).toBe(0); await relay.dispose();
});

test('completed relay results survive coordinator restart and worker restart abandons unfinished calls', async () => {
  const f = fixture(); let relay = f.relay(); const pending = f.search();
  await relay.tick(binding, connection, f.valid); await flush(); await relay.dispose(); relay = f.relay();
  await relay.tick(binding, connection, f.valid); expect(JSON.stringify(await pending)).toContain('HTTP 401'); expect(f.calls()).toBe(1); await relay.dispose();
  const controller = new AbortController();
  const abandoned = f.queue.call('task', 'current', 'turn', 'restart', 'history_search', { query: 'policy' }, controller.signal);
  const restored = new WorkerHistoryQueue(f.directory);
  expect(restored.exchange({ protocol: 1, enabled: true, results: [] }).requests).toHaveLength(0);
  expect(record(await restored.call('task', 'current', 'turn', 'restart', 'history_search', { query: 'policy' }, signal())).error).toContain('Worker restarted');
  controller.abort(); await abandoned;
});

test('bound account/project changes cannot deliver a finished result to another worker', async () => {
  const f = fixture(), relay = f.relay(), controller = new AbortController();
  const pending = f.queue.call('task', 'current', 'turn', 'scope', 'history_search', { query: 'Login policy' }, controller.signal);
  await relay.tick(binding, connection, f.valid); await flush(); f.invalidate();
  await relay.tick(binding, connection, f.valid);
  expect(f.queue.exchange({ protocol: 1, enabled: true, results: [] }).requests).toHaveLength(1);
  controller.abort(); expect(record(await pending).status).toBe('error'); await relay.dispose();
});

test('recreated containers refresh the source endpoint even when storage binding and token stay the same', async () => {
  const f = fixture(); let endpoint = connection.endpoint;
  const relay = new AgentHistoryRelay(join(f.directory, 'recreated.json'), {
    enabled: () => true, getKey: () => null, evaluate: f.evaluator,
    transport: (connected, route, body, signal) => {
      if (connected.endpoint !== endpoint) throw new Error('Old container endpoint.');
      return f.transport(connected, route, body, signal);
    },
  });
  await relay.tick(binding, connection, f.valid);
  endpoint = 'http://127.0.0.1:9877';
  const pending = f.search();
  await relay.tick(binding, { ...connection, endpoint }, f.valid); await flush();
  await relay.tick(binding, { ...connection, endpoint }, f.valid);
  expect(JSON.stringify(await pending)).toContain('HTTP 401'); expect(f.calls()).toBe(1);
  await relay.dispose();
});

test('recall waits never block collaboration exchanges, and disposal aborts pending transport', async () => {
  const f = fixture(), started = createDeferred<void>(); let exchanges = 0;
  const coordinator = createAgentOrchestration({ filename: join(f.directory, 'collaboration.json'),
    peer: () => ({ id: 'dev', name: 'Dev', role: 'development' }), connect: async () => connection,
    exchange: async () => { exchanges++; return { protocol: 1, outgoing: [], received: [] }; },
    history: { enabled: () => true, getKey: () => null, transport: async (_c, _r, _b, signal) => {
      started.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }));
    } },
  });
  coordinator.register(binding); await coordinator.tick(); await started.promise;
  await coordinator.tick(); expect(exchanges).toBe(2); await coordinator.dispose();
});

test('expired relay requests make no provider call and persistence failure publishes no request', async () => {
  const f = fixture(), relay = new AgentHistoryRelay(join(f.directory, 'expired.json'), {
    enabled: () => true, getKey: () => null, evaluate: f.evaluator,
    transport: async (...args) => {
      const raw = record(await f.transport(...args));
      if (args[1] !== '/history/exchange') return raw;
      return { ...raw, requests: (raw.requests as Record<string, unknown>[]).map(r => ({ ...r, deadline: Date.now() - 1 })) };
    },
  });
  const pending = f.search(); await deliver(f, relay);
  expect(record(await pending).error).toContain('deadline'); expect(f.calls()).toBe(0); await relay.dispose();
  mkdirSync(join(f.directory, 'state', 'history-requests.json.tmp'));
  await failure(f.search('persist-failure'), 'EISDIR');
  expect(f.queue.exchange({ protocol: 1, enabled: true, results: [] }).requests).toHaveLength(0);
});
