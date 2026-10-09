import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLifecycle } from '../lib/agent-management/lifecycle.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';
import type { AgentDetails } from '../shared/agent-management.ts';
import { workerStatus } from '../frontend/src/shared/agent-management/workerStatus.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-display-')); directories.push(directory);
  const filename = join(directory, 'lifecycle.json');
  const binding = bindingFor('/workspace', 'docker:test', 'dev', 'account');
  const connection = { endpoint: 'http://127.0.0.1:8787', token: 'test' };
  const details: AgentDetails = { agent: { id: 'worker', name: 'Worker', image: 'test', state: 'running',
    startedAt: '2026-10-09T00:00:00.000000001Z' }, ready: true, busy: false, error: null, logs: '', tasks: [], authenticated: true, threadId: null };
  let running = true, now = 0, confirmed = true;
  const calls: string[] = [];
  const options = { filename, now: () => now,
    inspect: async () => { calls.push('inspect'); return running ? { connection, details } : null; },
    start: async () => { calls.push('start'); return { connection, details }; },
    stopped: async () => { calls.push('stopped'); return confirmed; }, demand: () => false,
    changed: () => { calls.push('changed'); }, maintenance: () => { calls.push('maintenance'); },
    control: async (_connection: typeof connection, action: string) => {
      calls.push(action); if (action === 'commit') running = false;
      return { protocol: 1, idle: true, nextWakeAt: null, lease: 'lease' };
    } };
  const lifecycle = new WorkerLifecycle(options); lifecycle.adopt(binding, details);
  const stopped = { ...details.agent, state: 'exited' };
  return { lifecycle, options, filename, binding, details, stopped, calls, setRunning: (v: boolean) => { running = v; },
    unconfirmed: () => { confirmed = false; },
    sleep: async () => { await lifecycle.rest(binding, connection, false); now = 300_000; await lifecycle.rest(binding, connection, false); } };
}
test('confirmed sleep projection is immutable and neither saves nor reconciles, starts or changes deadlines', async () => {
  const f = fixture(); await f.sleep();
  const before = readFileSync(f.filename, 'utf8'), mtime = statSync(f.filename).mtimeMs;
  const deadline = f.lifecycle.nextCheck(f.binding), calls = [...f.calls];
  for (let i = 0; i < 3; i++) {
    const projected = f.lifecycle.project('docker:test', f.stopped)!;
    expect(projected).toEqual({ phase: 'sleeping', stopReason: 'sleep', error: null });
    expect(Object.isFrozen(projected)).toBe(true);
  }
  expect(readFileSync(f.filename, 'utf8')).toBe(before); expect(statSync(f.filename).mtimeMs).toBe(mtime);
  expect(f.calls).toEqual(calls); expect(f.lifecycle.nextCheck(f.binding)).toBe(deadline);
  const reloaded = new WorkerLifecycle(f.options);
  expect(reloaded.project('docker:test', f.stopped)?.phase).toBe('draining');
  expect(readFileSync(f.filename, 'utf8')).toBe(before); expect(f.calls).toEqual(calls);
});
test('manual and unexpected stops persist distinct reasons at existing journal writes', async () => {
  const manual = fixture();
  await manual.lifecycle.manual('docker:test', 'worker', 'stop', async () => { manual.setRunning(false); });
  expect(new WorkerLifecycle(manual.options).project('docker:test', manual.stopped)?.stopReason).toBe('manual');
  const crash = fixture(); crash.setRunning(false); await crash.lifecycle.connection(crash.binding, false);
  expect(new WorkerLifecycle(crash.options).project('docker:test', crash.stopped)?.stopReason).toBe('unexpected');
  expect(crash.calls).not.toContain('start');
});
test('same-container restart, replacement, foreign engine and legacy journal never inherit stop intent', async () => {
  const f = fixture(); await f.sleep();
  expect(f.lifecycle.project('docker:other', f.stopped)).toBeUndefined();
  expect(f.lifecycle.project('docker:test', { ...f.stopped, id: 'replacement' })).toBeUndefined();
  expect(f.lifecycle.project('docker:test', { ...f.stopped, startedAt: '2026-10-09T00:00:00.000000002Z' })).toBeUndefined();
  const journal = JSON.parse(readFileSync(f.filename, 'utf8'));
  delete journal[f.binding.id].stopReason;
  delete journal[f.binding.id].details.agent.startedAt;
  writeFileSync(f.filename, JSON.stringify(journal));
  expect(new WorkerLifecycle(f.options).project('docker:test', f.stopped)).toBeUndefined();
});
test('unconfirmed stop does not become manual and volatile display observations are not persisted', async () => {
  const f = fixture();
  f.details.agent.status = { observedAt: 1, health: { ready: true, busy: false, error: null } };
  f.lifecycle.adopt(f.binding, f.details);
  expect(readFileSync(f.filename, 'utf8')).not.toContain('observedAt');
  f.unconfirmed();
  let failure: unknown;
  try { await f.lifecycle.manual('docker:test', 'worker', 'stop', async () => {}); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const lifecycle = f.lifecycle.project('docker:test', f.stopped);
  expect(lifecycle?.stopReason).toBeUndefined();
  expect(workerStatus({ ...f.stopped, status: { observedAt: 100, lifecycle } }, null, 100)).toBe('unknown');
});

test('a startup phase left by a previous host cannot present ongoing startup', async () => {
  const f = fixture();
  await f.lifecycle.manual('docker:test', 'worker', 'restart', async () => {});
  expect(f.lifecycle.project('docker:test', f.details.agent)?.phase).toBe('starting');
  expect(new WorkerLifecycle(f.options).project('docker:test', f.details.agent)).toBeUndefined();
});

test('ambiguous saved bindings for the same execution do not select an arbitrary stop reason', async () => {
  const f = fixture(); await f.sleep();
  const journal = JSON.parse(readFileSync(f.filename, 'utf8'));
  const duplicate = `${f.binding.id}-duplicate`;
  journal[duplicate] = { ...journal[f.binding.id], binding: { ...f.binding, id: duplicate }, phase: 'disabled', stopReason: 'manual' };
  writeFileSync(f.filename, JSON.stringify(journal));
  expect(new WorkerLifecycle(f.options).project('docker:test', f.stopped)).toBeUndefined();
});
