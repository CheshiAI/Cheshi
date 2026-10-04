import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLifecycle } from '../lib/agent-management/lifecycle.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import type { AgentDetails } from '../shared/agent-management.ts';
import { parseAgentRuntimeState } from '../shared/agent-runtime.ts';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fails(operation: Promise<unknown>, text: string) {
  let failure: unknown; try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain(text);
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-lifecycle-')); directories.push(directory);
  const binding = bindingFor('/workspace', 'docker:test', 'dev', 'account');
  const connection = { endpoint: 'http://127.0.0.1:8787', token: 'private' };
  const details: AgentDetails = { agent: { id: 'container', name: 'dev', state: 'running', image: 'worker' }, ready: true, busy: false,
    authenticated: true, threadId: 'saved-thread', tasks: [], error: null, logs: '' };
  let now = 0, running = false, demand = false, idle = true, starts = 0, inspections = 0, failStart = false, nextWakeAt: number | null = null;
  let onPrepare = () => {}, confirmStop = true;
  const actions: string[] = [];
  const options = { filename: join(directory, 'lifecycle.json'), now: () => now,
    inspect: async () => { inspections++; return running ? { connection, details } : null; },
    start: async () => { starts++; if (failStart) throw new Error('Engine unavailable'); running = true; return { connection, details }; },
    stopped: async () => confirmStop,
    demand: () => demand,
    control: async (_connection: typeof connection, action: string) => {
      actions.push(action); if (action === 'prepare') onPrepare(); if (action === 'commit') running = false;
      return { protocol: 1, idle, nextWakeAt, lease: 'lease' };
    } };
  let lifecycle = new WorkerLifecycle(options);
  const connect = () => lifecycle.exclusive(binding, () => lifecycle.connection(binding, true));
  const rest = () => lifecycle.exclusive(binding, () => lifecycle.rest(binding, connection, false));
  return { binding, connection, details, options, connect, rest, actions, get lifecycle() { return lifecycle; },
    restart: () => { lifecycle = new WorkerLifecycle(options); },
    startCount: () => starts, inspectCount: () => inspections, setNow: (n: number) => { now = n; },
    setRunning: (v: boolean) => { running = v; }, setIdle: (v: boolean) => { idle = v; }, setDemand: (v: boolean) => { demand = v; },
    prepare: (fn: () => void) => { onPrepare = fn; }, failStart: () => { failStart = true; },
    deadline: (n: number) => { nextWakeAt = n; }, unconfirmed: () => { confirmStop = false; } };
}
test('simultaneous demand starts once, sleeps after safe idle, and stops querying sleeping Docker workers', async () => {
  const f = fixture(); await Promise.all([f.connect(), f.connect(), f.connect()]); expect(f.startCount()).toBe(1);
  await f.rest(); f.setNow(299999); await f.rest(); expect(f.actions).not.toContain('commit');
  f.setNow(300000); await f.rest(); expect(f.actions).toContain('commit');
  expect(parseAgentRuntimeState(f.lifecycle.cached(f.binding))).toMatchObject({ lifecycle: { phase: 'sleeping' }, details: { ready: false, threadId: 'saved-thread' } });
  const reads = f.inspectCount();
  for (let i = 0; i < 10; i++) expect(await f.lifecycle.connection(f.binding, false)).toBeNull();
  expect(f.inspectCount()).toBe(reads);
  await f.connect(); expect(f.startCount()).toBe(2);
});
test('busy work and pending demand from another room prevent sleep; prepare races cancel the lease', async () => {
  const f = fixture(); await f.connect(); f.setIdle(false); await f.rest(); f.setNow(1000000); await f.rest();
  expect(f.actions).not.toContain('prepare'); f.setIdle(true); f.setDemand(true); await f.rest();
  expect(f.actions).not.toContain('prepare'); f.setDemand(false); f.setNow(1120000); await f.rest();
  f.prepare(() => { f.lifecycle.demand(f.binding); }); f.setNow(1420000); await f.rest();
  expect(f.actions).toContain('resume'); expect(f.actions).not.toContain('commit');
  expect(f.lifecycle.nextCheck(f.binding)).toBeGreaterThan(1420000);
});
test('restart preserves sleeping state and the question deadline wakes the worker without a new message', async () => {
  const f = fixture(); await f.connect(); f.deadline(500000); await f.rest(); f.setNow(300000); await f.rest();
  f.restart(); expect(f.lifecycle.cached(f.binding)).toBeNull();
  expect(await f.lifecycle.connection(f.binding, false)).toBeNull();
  expect(f.lifecycle.cached(f.binding)?.lifecycle?.phase).toBe('sleeping');
  f.setNow(500000); await f.lifecycle.connection(f.binding, false); expect(f.startCount()).toBe(2);
});
test('deadlines schedule only idle sleep or a saved question; busy work has no recurring status deadline', async () => {
  const f = fixture(); await f.connect(); f.setIdle(false); await f.rest();
  expect(f.lifecycle.nextCheck(f.binding)).toBeNull();
  f.setNow(1000); f.setIdle(true); f.lifecycle.activity(f.binding); await f.rest();
  expect(f.lifecycle.nextCheck(f.binding)).toBe(301000);
  f.deadline(500000); f.setNow(301000); await f.rest();
  expect(f.lifecycle.nextCheck(f.binding)).toBe(500000);
  f.restart(); expect(f.lifecycle.nextCheck(f.binding)).toBe(500000);
});
test('manual stop persists across restart, and uncertain shutdown is never reported as confirmed sleep', async () => {
  const f = fixture(); await f.connect();
  await f.lifecycle.manual('docker:test', 'container', 'stop', async () => { f.setRunning(false); });
  f.restart(); await fails(f.connect(), 'manually stopped'); expect(f.startCount()).toBe(1);
  f.lifecycle.adopt(f.binding, f.details); f.setRunning(true); f.unconfirmed();
  await f.rest(); f.setNow(300000); await f.rest(); expect(f.lifecycle.cached(f.binding)).toBeNull();
  expect(f.lifecycle.nextCheck(f.binding)).toBe(420000);
});
test('manual stop captures newer activity and persists confirmed stopped details without waking', async () => {
  const f = fixture(); await f.connect();
  f.details.threadId = 'latest-thread';
  f.details.tasks.push({ id: 'recent', status: 'completed', prompt: 'Check', output: 'Done', error: null, createdAt: '2026-10-04' });
  await f.lifecycle.manual('docker:test', 'container', 'stop', async () => {
    expect(f.lifecycle.cached(f.binding)?.details?.agent.state).toBe('unknown');
    f.setRunning(false);
  });
  f.details.tasks[0]!.output = 'Later mutation';
  f.restart();
  const cached = parseAgentRuntimeState(f.lifecycle.cached(f.binding));
  expect(cached).toMatchObject({ lifecycle: { phase: 'disabled' }, details: {
    ready: false, busy: false, execution: null, agent: { state: 'exited' }, threadId: 'latest-thread',
    tasks: [{ id: 'recent', status: 'completed', output: 'Done' }],
  } });
  await fails(f.connect(), 'manually stopped'); expect(f.startCount()).toBe(1);
});
test('unacknowledged or unconfirmed manual stop retains latest tasks without claiming an exited container', async () => {
  for (const failure of ['operation', 'confirmation']) {
    const f = fixture(); await f.connect();
    f.details.tasks.push({ id: 'uncertain', status: 'unknown', prompt: 'Check', output: '', error: null, createdAt: '2026-10-04' });
    f.unconfirmed();
    await fails(f.lifecycle.manual('docker:test', 'container', 'stop', async () => {
      if (failure === 'operation') throw new Error('Lost acknowledgement');
    }), failure === 'operation' ? 'Lost acknowledgement' : 'not confirmed');
    f.restart();
    expect(f.lifecycle.cached(f.binding)).toMatchObject({ lifecycle: { phase: 'disabled' }, details: {
      agent: { state: 'unknown' }, tasks: [{ id: 'uncertain', status: 'unknown' }],
    } });
    await fails(f.connect(), 'manually stopped'); expect(f.startCount()).toBe(1);
  }
});
test('live snapshots refresh without resetting the idle timer and stopped snapshots cannot erase tasks', async () => {
  const f = fixture(); await f.connect(); await f.rest();
  f.details.tasks.push({ id: 'new', status: 'completed', prompt: '', output: 'Kept', error: null, createdAt: '2026-10-04' });
  await f.lifecycle.connection(f.binding, false);
  f.setNow(300000); await f.rest(); expect(f.actions).toContain('commit');
  await f.lifecycle.manual('docker:test', 'container', 'stop', async () => {}, async () => ({
    ...f.details, agent: { ...f.details.agent, state: 'exited' }, tasks: [], threadId: null,
  }));
  expect(f.lifecycle.cached(f.binding)?.details?.tasks.map(t => t.id)).toEqual(['new']);
});
test('incomplete activity or foreign container snapshots do not overwrite saved details or execute control', async () => {
  for (const foreign of [false, true]) {
    const f = fixture(); await f.connect(); let controlled = false;
    await fails(f.lifecycle.manual('docker:test', 'container', 'stop', async () => { controlled = true; }, async () => ({
      ...f.details, error: foreign ? null : 'Task history is unavailable.',
      agent: { ...f.details.agent, id: foreign ? 'other' : 'container' },
    })), foreign ? 'identity changed' : 'latest worker details');
    expect(controlled).toBe(false); expect(f.lifecycle.state(f.binding)?.phase).toBe('running');
  }
});
test('failed wake attempts back off, stop after three attempts and require an explicit retry', async () => {
  const f = fixture(); f.failStart();
  await fails(f.connect(), 'Engine unavailable'); await fails(f.connect(), 'Engine unavailable'); expect(f.startCount()).toBe(1);
  f.setNow(30000); await fails(f.connect(), 'Engine unavailable');
  f.setNow(90000); await fails(f.connect(), 'Engine unavailable');
  f.setNow(999999); await fails(f.connect(), 'Engine unavailable'); expect(f.startCount()).toBe(3);
  f.lifecycle.retry(f.binding); await fails(f.connect(), 'Engine unavailable'); expect(f.startCount()).toBe(4);
});
test.each([false, true])('successful inspection clears retry state without resetting idle scheduling (idle: %s)', async idle => {
  const f = fixture(); await f.connect(); f.setIdle(idle); await f.rest();
  const inspect = f.options.inspect;
  f.options.inspect = async () => { throw new Error('Temporary Docker failure'); };
  f.setNow(1000); await fails(f.lifecycle.connection(f.binding, false), 'Temporary Docker failure');
  expect(f.lifecycle.nextCheck(f.binding)).toBe(31000);
  f.setNow(31000); f.options.inspect = inspect;
  expect(await f.lifecycle.connection(f.binding, false)).toEqual(f.connection);
  await f.rest();
  expect(f.lifecycle.state(f.binding)).toEqual({ phase: 'running', error: null });
  expect(f.lifecycle.nextCheck(f.binding)).toBe(idle ? 300000 : null);
  f.options.inspect = async () => { throw new Error('Another Docker failure'); };
  f.setNow(40000); await fails(f.lifecycle.connection(f.binding, false), 'Another Docker failure');
  expect(f.lifecycle.nextCheck(f.binding)).toBe(70000);
});
test('incomplete inspection continues backoff until healthy details confirm recovery', async () => {
  const f = fixture(); await f.connect();
  const inspect = f.options.inspect;
  f.options.inspect = async () => { throw new Error('Temporary Docker failure'); };
  await fails(f.lifecycle.connection(f.binding, false), 'Temporary Docker failure');
  f.options.inspect = inspect; f.setNow(30000);
  f.details.error = 'Task history is unavailable.';
  await fails(f.lifecycle.connection(f.binding, false), 'Task history is unavailable.');
  expect(f.lifecycle.nextCheck(f.binding)).toBe(90000);
  const reads = f.inspectCount();
  expect(await f.lifecycle.connection(f.binding, false)).toBeNull();
  expect(f.inspectCount()).toBe(reads);
  f.setNow(90000); f.details.error = null;
  expect(await f.lifecycle.connection(f.binding, false)).toEqual(f.connection);
  expect(f.lifecycle.state(f.binding)).toEqual({ phase: 'running', error: null });
  expect(f.lifecycle.nextCheck(f.binding)).toBeNull();
});
test('a host crash before sleep commit releases preparation without replaying or creating a worker', async () => {
  const f = fixture(); await f.connect(); await f.rest(); f.setNow(300000);
  f.options.control = async (_connection, action) => { f.actions.push(action); if (action === 'commit') throw new Error('Lost commit'); return { protocol: 1, idle: true, nextWakeAt: null, lease: 'lease' }; };
  await f.rest(); f.restart(); await f.connect();
  expect(f.actions).toContain('resume'); expect(f.startCount()).toBe(1);
});

test('foreign account bindings and a replacement container cannot inherit a saved lifecycle', async () => {
  const f = fixture(); await f.connect();
  expect(() => f.lifecycle.cached({ ...f.binding, accountId: 'other-account' })).toThrow('identity changed');
  f.details.agent.id = 'replacement';
  await fails(f.connect(), 'Worker identity changed'); expect(f.startCount()).toBe(1);
});

test('an open container terminal prevents sleep and opening one during preparation cancels sleep', async () => {
  const f = fixture(); await f.connect();
  const release = f.lifecycle.hold('docker:test', 'container');
  await f.rest(); f.setNow(300000); await f.rest(); expect(f.actions).not.toContain('prepare');
  release(); release(); await f.rest(); f.setNow(600000);
  let close = () => {};
  f.prepare(() => { close = f.lifecycle.hold('docker:test', 'container'); }); await f.rest();
  expect(f.actions).toContain('resume'); expect(f.actions).not.toContain('commit'); close();
  f.prepare(() => {}); f.setNow(720000); await f.rest(); f.setNow(1020000); await f.rest();
  expect(f.actions).toContain('commit');
  expect(() => f.lifecycle.hold('docker:test', 'container')).toThrow('Start this worker');
});
