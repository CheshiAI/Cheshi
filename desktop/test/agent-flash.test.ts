import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../../experiments/codex-specialists/src/store.ts';
import { WorkerFlashHistory } from '../../experiments/codex-specialists/src/flash-history.ts';
import { WorkerFlashQueue, type FlashRequest } from '../../experiments/codex-specialists/src/flash-queue.ts';
import { memoryArguments } from '../../experiments/codex-specialists/src/flash-tools.ts';
import { FlashWorkerConnection } from '../lib/agent-orchestration/flash-relay.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import { AgentFlashMemory } from '../lib/flash/agent-memory.mts';
import { dockerMemoryOwner, dockerSessionId, DockerMemoryArchive } from '../lib/flash/docker-archive.mts';
import { flashFixture, fixtureSummary } from './flash-test-helpers.ts';
import { flashSourceTarget } from '../shared/flash-memory.ts';
import { FakeClient } from '../../experiments/codex-specialists/src/agent-test-client.ts';
import { SpecialistAgent } from '../../experiments/codex-specialists/src/agent.ts';
import { createDeferred, record } from '../../experiments/codex-specialists/src/protocol.ts';
import { FlashError } from '../lib/flash/client.mts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
async function directory() { const value = await mkdtemp(join(tmpdir(), 'cheshi-agent-flash-')); cleanup.push(() => rm(value, { recursive: true, force: true })); return value; }
async function fails(operation: Promise<unknown>, message?: string) {
  let error: unknown; try { await operation; } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error); if (message) expect(String(error)).toContain(message);
}
const binding = bindingFor('/project', 'docker:local', 'alice', 'account');
const ownSession = (text = 'Flash 플래시 변경 이유는 원문 근거가 필요하기 때문입니다.') => ({ threadId: 'docker-thread', title: 'Docker decision', entries: [
  { turnId: 'turn', itemId: 'message', kind: 'assistant' as const, text },
] });
const request = (tool = 'memory_search', args: Record<string, unknown> = { query: 'Flash 변경 이유' }): FlashRequest => ({ id: 'request', tool, args, threadId: 'current', turnId: 'current-turn', deadline: Date.now() + 60_000 });
async function setup() {
  const root = await directory(), fixture = await flashFixture(); cleanup.push(fixture.close);
  let valid = true, authenticated = true;
  const memory = new AgentFlashMemory(root, b => valid && b.agentId === 'alice' && b.accountId === 'account', fixture.host);
  cleanup.push(() => memory.dispose());
  const localCalls: Record<string, unknown>[] = [];
  const unregister = memory.register('/project', { authenticated: () => authenticated, summarize: fixtureSummary,
    original: async () => 'local original', memory: { execute: async (method, args) => {
      localCalls.push({ method, ...args });
      return method === 'memory_search' ? { matches: [{ session_id: 'local-thread', turn_id: 'local-turn', source_id: 'local', text: 'Local project decision' }] }
        : { summary: 'Local project decision', evidence: [{ quote: 'Local project decision' }] };
    } } });
  return { root, fixture, memory, localCalls, unregister, revoke: () => { valid = false; }, signOut: () => { authenticated = false; } };
}

test('Docker history exports completed visible originals and paginates only task-owned threads', async () => {
  const store = new AgentStore(await directory());
  for (const id of ['a', 'b']) { store.create(id, `Goal ${id}`); store.update(id, { threadId: id, status: 'completed' }); }
  const read: string[] = [];
  const history = new WorkerFlashHistory(store, async id => {
    read.push(id); return { thread: { id, turns: [
      { id: 'done', status: 'completed', items: [
        { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '왜 바꿨지?' }, { type: 'image', data: 'private image' }] },
        { id: 'a', type: 'agentMessage', text: '원문을 유지하기 위해서입니다.' },
        { id: 'tool', type: 'commandExecution', aggregatedOutput: 'internal secret output' },
      ] }, { id: 'running', status: 'inProgress', items: [{ id: 'partial', type: 'agentMessage', text: 'partial' }] },
    ] } };
  });
  const first = record(await history.page({}));
  expect(first.next).toBe('a'); expect(JSON.stringify(first)).not.toContain('internal secret'); expect(JSON.stringify(first)).not.toContain('private image'); expect(JSON.stringify(first)).not.toContain('partial');
  const second = record(await history.page({ revision: first.revision, after: first.next }));
  expect(second.next).toBeNull(); expect(read).toEqual(['a', 'b']);
  expect(record(await history.page({ revision: first.revision })).unchanged).toBe(true);
  store.update('a', { output: 'changed' });
  await fails(history.page({ revision: first.revision, after: first.next }), 'changed');
});

test('archive persists across recreation, isolates owners and replaces deleted worker sessions', async () => {
  const root = await directory(), archive = new DockerMemoryArchive(root), owner = dockerMemoryOwner(binding);
  await archive.replace(binding, 'worker', [ownSession()], () => true);
  await archive.replace(binding, 'isolated:task', [{ ...ownSession('isolated original'), threadId: 'isolated' }], () => true);
  const recreated = new DockerMemoryArchive(root);
  expect((await recreated.sources(owner)).sources).toHaveLength(2);
  expect((await recreated.sources(dockerMemoryOwner({ ...binding, agentId: 'bob' }))).sources).toEqual([]);
  expect((await recreated.sources(dockerMemoryOwner({ ...binding, workspace: '/other' }))).sources).toEqual([]);
  expect((await recreated.sources(dockerMemoryOwner({ ...binding, accountId: 'other' }))).sources).toEqual([]);
  await recreated.replace(binding, 'worker', [], () => true);
  const remaining = (await recreated.sources(owner)).sources;
  expect(remaining).toHaveLength(1); expect(remaining[0]!.document.text).toBe('isolated original');
  await fails(recreated.replace(binding, 'worker', [ownSession()], () => false), 'assignment');
});

test('one search returns Docker and local origins; reads retain exact quotes and resolve archived links', async () => {
  const { memory, localCalls } = await setup(), signal = new AbortController().signal;
  await memory.archive.replace(binding, 'worker', [ownSession()], () => true);
  await memory.archive.replace({ ...binding, agentId: 'bob' }, 'worker', [ownSession('BOB PRIVATE')], () => true);
  const found = record(await memory.execute(binding, request(), signal));
  const matches = found.matches as Record<string, unknown>[];
  expect(matches.map(m => m.origin)).toEqual(['docker', 'local']); expect(JSON.stringify(found)).not.toContain('BOB PRIVATE');
  expect(found.partial).toBe(false); expect(localCalls[0]!.query).toBe('Flash 변경 이유');
  const turns = matches.map(m => ({ session_id: m.session_id, turn_id: m.turn_id }));
  const read = record(await memory.execute(binding, request('memory_read', { question: '왜 바꿨지?', turns }), signal));
  const results = read.results as { origin: string; evidence: { quote: string; source_url: string }[] }[];
  expect(results.map(r => r.origin)).toEqual(['docker', 'local']);
  const evidence = results[0]!.evidence[0]!, target = flashSourceTarget(evidence.source_url)!;
  expect(target.owner).toBe(dockerMemoryOwner(binding)); expect(evidence.quote).toBe(ownSession().entries[0]!.text);
  expect(await memory.original('/project', target)).toBe(evidence.quote);
  await fails(memory.original('/other', target), 'ownership');
  await fails(memory.execute(binding, request('memory_read', { question: 'why', turns: [{ session_id: dockerSessionId(dockerMemoryOwner({ ...binding, agentId: 'bob' }), 'docker-thread'), turn_id: 'turn' }] }), signal), 'outside');
});

test('unavailable local memory is explicit, and revoked assignments suppress both search and source reads', async () => {
  const { memory, unregister, revoke } = await setup(), signal = new AbortController().signal;
  await memory.archive.replace(binding, 'worker', [ownSession()], () => true);
  unregister();
  const found = record(await memory.execute(binding, request(), signal));
  expect(found.partial).toBe(true); expect(record(found.coverage).local).toBe('unavailable');
  revoke();
  await fails(memory.execute(binding, request(), signal), 'assignment');
  await fails(memory.original('/project', { owner: dockerMemoryOwner(binding), threadId: dockerSessionId(dockerMemoryOwner(binding), 'docker-thread'), itemId: 'message' }), 'ownership');
});

test('combined ranking sees both candidate pools before limiting, then revalidates local originals', async () => {
  const { memory, localCalls } = await setup(), signal = new AbortController().signal;
  await memory.archive.replace(binding, 'worker', [ownSession()], () => true);
  let verified = false;
  memory.register('/project', { authenticated: () => true, summarize: fixtureSummary, original: async () => '',
    memory: { execute: async () => { throw new Error('Must use the unranked candidate path'); },
      searchCandidates: async args => { localCalls.push(args); return { matches: [{ source_id: 'local', text: 'answer' }] }; } },
    rerank: async (query, candidates) => {
      expect(query).toBe('why'); expect(candidates.map(c => c.origin)).toEqual(['docker', 'local']);
      return candidates.toReversed();
    },
    verifyCandidates: async matches => { expect(matches.map(m => m.source_id)).toEqual(['local']); verified = true; },
  });
  const found = record(await memory.execute(binding, request('memory_search', { query: 'why', limit: 1 }), signal));
  expect(localCalls[0]!.limit).toBe(30);
  expect(found.matches).toEqual([{ source_id: 'local', text: 'answer', origin: 'local' }]);
  expect(verified).toBe(true); expect(found.ranking).toBe('relevance');
});

test('worker queue and host bridge perform history sync, query delivery and cancellation end to end', async () => {
  const { memory } = await setup(), store = new AgentStore(await directory()), queue = new WorkerFlashQueue();
  store.create('task', 'Flash 이유'); store.update('task', { threadId: 'docker-thread', status: 'completed' });
  const history = new WorkerFlashHistory(store, async id => ({ thread: { id, turns: [{ id: 'turn', status: 'completed', items: [{ id: 'message', type: 'agentMessage', text: ownSession().entries[0]!.text }] }] } }));
  const done = createDeferred<void>();
  const bridge = new FlashWorkerConnection(memory, binding, async (route, body) => route === '/flash/history' ? history.page(body) : queue.exchange(body), () => true, () => done.resolve());
  cleanup.push(() => bridge.dispose());
  const controller = new AbortController();
  const pending = queue.call('memory_search', { query: '플래시 이유' }, 'current', 'turn', controller.signal);
  await bridge.tick(); await done.promise; await bridge.tick();
  expect(record(await pending).partial).toBe(false);
  const canceled = queue.call('memory_search', { query: 'why' }, 'current', 'turn', controller.signal);
  controller.abort(); expect(record(await canceled).isError).toBe(true); expect(queue.pending).toBe(false);
  expect(() => memoryArguments('memory_search', { query: 'why', workspace: '/other' })).toThrow();
});

test('Docker fallback returns both scopes and still refuses a changed original after inference', async () => {
  const { memory } = await setup(), signal = new AbortController().signal;
  await memory.archive.replace(binding, 'worker', [ownSession()], () => true);
  let stale = false, verified = 0;
  memory.register('/project', { authenticated: () => true, summarize: fixtureSummary, original: async () => '',
    memory: { execute: async () => ({}), searchCandidates: async () => ({ matches: [{ source_id: 'local', text: 'answer' }] }) },
    rerank: async () => { throw new FlashError('model_unavailable', 'PRIVATE'); },
    verifyCandidates: async () => { verified++; if (stale) throw new FlashError('stale_source', 'changed original'); },
  });
  const found = record(await memory.execute(binding, request(), signal));
  expect(found.ranking).toBe('local_fallback'); expect(found.degraded).toBe(true);
  expect((found.matches as { origin: string }[]).map(m => m.origin)).toEqual(['docker', 'local']);
  expect(verified).toBe(1); expect(JSON.stringify(found)).not.toContain('PRIVATE');
  stale = true;
  await fails(memory.execute(binding, request(), signal), 'changed original');
});

test('account revocation and modified originals during summary never return successful stale evidence', async () => {
  const { memory, signOut } = await setup(), signal = new AbortController().signal;
  await memory.archive.replace(binding, 'worker', [ownSession()], () => true);
  const ref = { session_id: dockerSessionId(dockerMemoryOwner(binding), 'docker-thread'), turn_id: 'turn' };
  let changed = false;
  memory.register('/project', { authenticated: () => true, original: async () => '', memory: { execute: async () => ({}) },
    summarize: async input => { changed = true; await memory.archive.replace(binding, 'worker', [ownSession('Changed decision')], () => true); return fixtureSummary(input); } });
  await fails(memory.execute(binding, request('memory_read', { question: 'Why?', turns: [ref] }), signal), 'changed');
  expect(changed).toBe(true);
  memory.register('/project', { authenticated: () => !changed, original: async () => '', memory: { execute: async () => ({}) },
    summarize: async input => { changed = true; signOut(); return fixtureSummary(input); } });
  changed = false;
  await fails(memory.execute(binding, request('memory_read', { question: 'Why?', turns: [ref] }), signal), 'accounts changed');
});

test('bridge retries a moving history snapshot and discards a revoked in-flight result', async () => {
  const { memory, revoke } = await setup(), queue = new WorkerFlashQueue();
  const { FlashHistoryChanged } = await import('../../experiments/codex-specialists/src/flash-history.ts');
  const gate = createDeferred<void>(), began = createDeferred<void>(), done = createDeferred<void>();
  let pages = 0, valid = true;
  memory.register('/project', { authenticated: () => true, summarize: fixtureSummary, original: async () => '', memory: {
    execute: async () => { began.resolve(); await gate.promise; return { matches: [] }; },
  } });
  const bridge = new FlashWorkerConnection(memory, binding, async (route, body) => {
    if (route === '/flash/exchange') return queue.exchange(body);
    if (++pages === 1) throw new FlashHistoryChanged('Moved');
    return { revision: 'a'.repeat(64), session: ownSession(), next: null };
  }, () => valid, () => done.resolve());
  cleanup.push(() => bridge.dispose());
  const controller = new AbortController();
  const result = queue.call('memory_search', { query: 'why' }, 'current', 'turn', controller.signal);
  await bridge.tick(); await began.promise;
  expect(pages).toBe(2);
  valid = false; revoke(); gate.resolve(); await done.promise;
  await fails(bridge.tick(), 'assignment');
  controller.abort(); expect(record(await result).isError).toBe(true);
});

test('read-only Docker turns expose Flash, route calls, and retain capability across restart', async () => {
  const root = await directory(), store = new AgentStore(root), client = new FakeClient(), queue = new WorkerFlashQueue();
  client.onStart = async () => ({ turn: { id: 'turn' } });
  const agent = new SpecialistAgent({ client, store, profile: 'Read only', workspace: '/workspace', flash: queue });
  agent.submit('task', 'Find our last decision'); await client.started.promise; await new Promise(resolve => setTimeout(resolve, 5));
  const start = client.calls.find(c => c.method === 'thread/start')!;
  expect((start.params.dynamicTools as { name: string }[]).map(t => t.name)).toContain('memory_search');
  const tool = client.toolHandler!({ tool: 'memory_search', arguments: { query: 'why' }, threadId: 'thread', turnId: 'turn' });
  const request = queue.exchange({ protocol: 1, results: [] }).requests[0]!;
  queue.exchange({ protocol: 1, results: [{ id: request.id, result: { matches: [] } }] });
  expect(await tool).toEqual({ matches: [] });
  await fails(client.toolHandler!({ tool: 'memory_search', arguments: { query: 'why' }, threadId: 'foreign', turnId: 'turn' }), 'active task');
  client.complete(); await agent.settled();
  expect(new AgentStore(root).task('task')!.flashTools).toBe(true);
});
