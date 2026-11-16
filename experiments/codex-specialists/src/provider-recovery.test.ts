import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRequestError, providerFailure, retryInference, retryDelay, assertRetryCheckpoint } from './provider-recovery.ts';
import { SpecialistAgent } from './agent.ts';
import { AgentStore } from './store.ts';
import { FakeClient } from './agent-test-client.ts';
import { IdleLifecycle } from './idle-lifecycle.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture(store?: AgentStore) {
  if (!store) { const root = mkdtempSync(join(tmpdir(), 'provider-recovery-')); roots.push(root); store = new AgentStore(root); }
  const client = new FakeClient(), agent = new SpecialistAgent({ client, store, workspace: '/workspace', profile: 'read only' });
  let starts = 0;
  client.onStart = async () => {
    starts++;
    client.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed',
      items: [{ id: 'partial', type: 'agentMessage', phase: 'final_answer', text: 'Already answered A.' }],
      error: { code: 'server_overloaded', message: 'Busy', retryAfterMs: 1 } } } });
    return { turn: { id: 'turn' } };
  };
  client.onRead = async () => ({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'failed', items: [] }] } });
  return { store, client, agent, starts: () => starts };
}
async function failure(operation: () => Promise<unknown>) {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Expected rejection');
}
async function pump(f: ReturnType<typeof fixture>) {
  const t = f.store.task('task')!;
  f.store.update('task', { providerCheckpoint: { ...t.providerCheckpoint!, retryAt: 0 } });
  f.agent.pump();
  for (let i = 0; i < 100 && (f.agent.busy || f.store.task('task')?.providerCheckpoint?.pending); i++) await new Promise(r => setTimeout(r, 1));
  await f.agent.settled();
}

test('only known transient failures retry twice, preserving retry-after and cancellation', async () => {
  const waits: number[] = []; let calls = 0;
  const error = await failure(() => retryInference(async () => { calls++; throw new ProviderRequestError({ code: 'server_overloaded', retryAfterMs: 2000 }); },
    new AbortController().signal, async ms => { waits.push(ms); }));
  expect(error).toBeInstanceOf(ProviderRequestError); expect(calls).toBe(3); expect(waits).toEqual([2000, 3000]);
  for (const code of ['insufficient_quota', 'authentication_error', 'unknown']) {
    let attempts = 0;
    await failure(() => retryInference(async () => { attempts++; throw new ProviderRequestError({ code }); }, new AbortController().signal));
    expect(attempts).toBe(1);
  }
  const controller = new AbortController(); let attempts = 0;
  await failure(() => retryInference(async () => { attempts++; throw new ProviderRequestError({ code: 'server_overloaded' }); }, controller.signal,
    async () => { controller.abort(); }));
  expect(attempts).toBe(1);
  expect(providerFailure({ message: 'Selected model is at capacity. Please try a different model.' }).retryable).toBe(true);
  expect(providerFailure({ code: -32000, data: { codexErrorInfo: 'serverOverloaded', retryAfterMs: 1500 } }))
    .toEqual({ code: 'serverOverloaded', retryable: true, retryAfterMs: 1500 });
  expect(retryDelay({ code: 'server_overloaded', retryable: true, retryAfterMs: 60000 }, 0)).toBeNull();
});

test('checkpoint survives restart, keeps completed output and resumes the same thread once', async () => {
  const f = fixture(); f.agent.submit('task', 'Read A then B'); await f.agent.settled();
  expect(f.store.task('task')).toMatchObject({ status: 'waiting', output: 'Already answered A.', providerFailure: { code: 'server_overloaded' } });
  expect(new IdleLifecycle({ store: f.store, client: f.client, blocked: () => false }).probe().idle).toBe(false);
  const restarted = fixture(new AgentStore(f.store.directory));
  restarted.client.onStart = async params => {
    expect(JSON.stringify(params.input)).toContain('unfinished read-only');
    expect(params.threadId).toBe('thread');
    restarted.client.complete('completed', 'Answer B.'); return { turn: { id: 'turn' } };
  };
  await pump(restarted);
  expect(restarted.store.task('task')).toMatchObject({ status: 'completed', output: 'Already answered A.\n\nAnswer B.', providerCheckpoint: { attempts: 1, pending: false } });
  restarted.agent.pump();
  expect(restarted.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('repeated overload is bounded across persisted continuations', async () => {
  const f = fixture(); f.agent.submit('task', 'Read A'); await f.agent.settled();
  await pump(f); await pump(f);
  expect(f.starts()).toBe(3); expect(f.store.task('task')?.status).toBe('failed');
  f.agent.pump(); expect(f.starts()).toBe(3);
});

test('lost acknowledgement during continuation retains completed output and prevents replay', async () => {
  const f = fixture(); f.agent.submit('task', 'Read A then B'); await f.agent.settled();
  f.client.onStart = async () => { throw new Error('acknowledgement lost'); };
  await pump(f);
  expect(f.store.task('task')).toMatchObject({ status: 'unknown', output: 'Already answered A.' });
  f.agent.pump();
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
});

test.each(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'])('a possibly executed %s prevents automatic repetition', async type => {
  const f = fixture();
  f.client.onStart = async () => {
    f.client.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed',
      items: [{ type, id: 'write', command: 'write-file', tool: 'work_write', status: 'completed' }], error: { code: 'server_overloaded', message: 'Busy' } } } });
    return { turn: { id: 'turn' } };
  };
  f.agent.submit('task', 'work'); await f.agent.settled(); f.agent.pump();
  expect(f.store.task('task')).toMatchObject({ status: 'failed', recoveryUnsafe: true });
  expect(f.client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});

test('changed native history and user cancellation prevent continuation', async () => {
  for (const canceled of [false, true]) {
    const f = fixture(); f.agent.submit('task', 'Read A'); await f.agent.settled();
    if (canceled) await f.agent.stop('task');
    else f.client.onRead = async () => ({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'other-turn', status: 'failed', items: [] }] } });
    await pump(f);
    expect(f.store.task('task')?.status).toBe('interrupted'); expect(f.starts()).toBe(1);
  }
});

test('recovery rejects foreign, forked, ephemeral, duplicate or incomplete native turns', () => {
  const checkpoint = { attempts: 1, retryAt: 0, threadId: 'thread', turnId: 'turn', pending: true };
  const turn = { id: 'turn', status: 'failed', items: [] };
  for (const patch of [{ id: 'foreign' }, { cwd: '/other' }, { parentThreadId: 'parent' }, { ephemeral: true },
    { turns: [turn, turn] }, { turns: [{ ...turn, status: 'inProgress' }] }]) {
    expect(() => assertRetryCheckpoint({ thread: { id: 'thread', cwd: '/workspace', turns: [turn], ...patch } }, checkpoint, '/workspace')).toThrow('Cannot safely resume');
  }
});
