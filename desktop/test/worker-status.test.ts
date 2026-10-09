import { expect, test } from 'bun:test';
import { parseManagedAgent, type AgentDetails, type ManagedAgent, type WorkerLifecycleDisplay } from '../shared/agent-management.ts';
import { workerStatus, workerStatusLabel, WORKER_STATUS_MAX_AGE_MS } from '../frontend/src/shared/agent-management/workerStatus.ts';

const now = 100_000, startedAt = '2026-10-09T00:00:00.123456789Z';
function agent(state = 'running', lifecycle?: WorkerLifecycleDisplay): ManagedAgent {
  return { id: 'worker', name: 'Worker', image: 'test', state, startedAt,
    status: { observedAt: now, ...(lifecycle ? { lifecycle } : {}) } };
}
function details(worker: ManagedAgent, ready = true, busy = false): AgentDetails {
  return { agent: { ...worker, status: { ...worker.status!, health: { ready, busy, error: null } } },
    ready, busy, error: null, authenticated: true, threadId: null, logs: '', tasks: [] };
}
test('only fresh literal ready/busy health establishes busy or idle; Docker running is insufficient', () => {
  const worker = agent();
  expect(workerStatus(worker, null, now)).toBe('unknown');
  expect(workerStatus(worker, details(worker, true, true), now)).toBe('busy');
  expect(workerStatus(worker, details(worker), now)).toBe('idle');
  expect(workerStatus(worker, details(worker, false), now)).toBe('unknown');
  expect(workerStatus(worker, details(worker), now + WORKER_STATUS_MAX_AGE_MS)).toBe('unknown');
  expect(workerStatus(worker, details(worker), now - 1)).toBe('unknown');
  expect(workerStatus(worker, details(worker), now, true)).toBe('unknown');
  for (const busy of ['false', 0, null, undefined]) {
    expect(() => parseManagedAgent({ ...worker, status: { observedAt: now, health: { ready: true, busy, error: null } } })).toThrow();
  }
  expect(() => parseManagedAgent({ ...worker, status: { observedAt: now, health: { ready: 'true', busy: false, error: null } } })).toThrow();
});
test('sleep, manual stop and unexpected exit require the corresponding lifecycle evidence', () => {
  for (const [phase, stopReason, status] of [
    ['sleeping', 'sleep', 'sleeping'], ['disabled', 'manual', 'manual'], ['disabled', 'unexpected', 'error'],
  ] as const) {
    const worker = agent('exited', { phase, stopReason, error: phase === 'disabled' ? 'Stopped' : null });
    expect(workerStatus(worker, null, now)).toBe(status);
    expect(workerStatus({ ...worker, state: 'running' }, details({ ...worker, state: 'running' }), now)).toBe('unknown');
  }
  expect(workerStatus(agent('exited', { phase: 'disabled', error: 'Worker manually stopped.' }), null, now)).toBe('unknown');
  expect(workerStatus(agent('exited'), null, now)).toBe('unknown');
  expect(workerStatus(agent('exited', { phase: 'draining', stopReason: 'sleep', error: null }), null, now)).toBe('unknown');
  expect(workerStatusLabel(agent('exited', { phase: 'sleeping', stopReason: 'sleep', error: null }), null, now)).toBe('수면 중(작업이 오면 자동 시작)');
});
test('starting must be observed and conflicting, stale or missing evidence stays unknown', () => {
  const worker = agent('running', { phase: 'starting', error: null });
  expect(workerStatus(worker, details(worker, false), now)).toBe('starting');
  expect(workerStatus(worker, details(worker, true), now)).toBe('unknown');
  expect(workerStatus(worker, details(worker, false, true), now)).toBe('unknown');
  const ready = agent('running', { phase: 'running', error: null });
  const old = details(ready);
  old.agent.startedAt = '2026-10-09T00:00:00.123456790Z';
  expect(workerStatus(ready, old, now)).toBe('unknown');
  expect(workerStatus(worker, details(ready), now)).toBe('unknown');
  expect(workerStatus({ ...ready, startedAt: undefined }, null, now)).toBe('unknown');
  expect(workerStatus({ ...ready, pendingDeletion: { deleteData: false } }, details(ready), now)).toBe('unknown');
  expect(workerStatus(ready, { ...details(ready), agent: { ...ready, status: undefined } }, now)).toBe('unknown');
});
test('health errors are distinct from log errors and draining is not invented recovery', () => {
  const worker = agent();
  const result = details(worker);
  result.error = 'Could not read worker logs.';
  expect(workerStatus(worker, result, now)).toBe('idle');
  result.agent.status!.health!.error = 'Startup failed';
  expect(workerStatus(worker, result, now)).toBe('error');
  const draining = agent('running', { phase: 'draining', error: null });
  expect(workerStatus(draining, details(draining), now)).toBe('unknown');
});
