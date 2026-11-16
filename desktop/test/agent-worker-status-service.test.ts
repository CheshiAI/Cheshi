import { expect, test } from 'bun:test';
import { createAgentManagementService } from '../lib/agent-management/service.mts';
import type { AgentEngine, RuntimeAgent } from '../lib/agent-management/engine.mts';
import { parseAgentDetails, parseAgentSnapshot } from '../shared/agent-management.ts';
import { workerStatus } from '../frontend/src/shared/agent-management/workerStatus.ts';

function fixture() {
  let worker: RuntimeAgent = { id: 'worker', name: 'Worker', image: 'test', state: 'running',
    startedAt: '2026-10-09T00:00:00.000000001Z', endpoint: 'http://127.0.0.1:8787' };
  let health: unknown = { role: 'development', ready: true, busy: false, threadId: null, error: null };
  let logFailure = false, healthFailure = false, afterHealth = () => {}, inspections = 0, now = 100_000;
  const calls: string[] = [];
  const engine: AgentEngine = { kind: 'docker', engines: async () => [], list: async () => [worker],
    inspect: async () => { inspections++; return { ...worker }; },
    control: async () => { throw Error('Display must not control a worker'); },
    logs: async () => { if (logFailure) throw Error('logs unavailable'); return 'saved logs'; } };
  const service = createAgentManagementService({ engines: [engine], now: () => now,
    displayLifecycle: () => worker.state === 'exited' ? { phase: 'sleeping', stopReason: 'sleep', error: null } : undefined,
    read: async (_endpoint, path) => {
      calls.push(path);
      if (path === '/health') { afterHealth(); if (healthFailure) throw Error('offline'); return health; }
      if (path === '/account') return { authenticated: true };
      return { tasks: [] };
    } });
  return { service, worker: () => worker, calls, inspections: () => inspections,
    setNow: (value: number) => { now = value; },
    logsFail: () => { logFailure = true; }, healthFail: () => { healthFailure = true; },
    health: (value: unknown) => { health = value; }, afterHealth: (fn: () => void) => { afterHealth = fn; },
    replace: (patch: Partial<RuntimeAgent>) => { worker = { ...worker, ...patch }; } };
}
test('healthy worker status survives a log failure, and snapshot projection does not mutate engine data', async () => {
  const f = fixture(); f.logsFail();
  const snapshot = parseAgentSnapshot(await f.service.snapshot('docker:test'));
  const result = parseAgentDetails(await f.service.details('docker:test', 'worker'));
  expect(result.error).toContain('Could not read worker logs');
  expect(result.ready).toBe(true);
  expect(result.agent.status?.health).toEqual({ ready: true, busy: false, error: null });
  expect(workerStatus(snapshot.agents[0]!, result, 100_000)).toBe('idle');
  expect(f.worker().status).toBeUndefined();
  expect(f.inspections()).toBe(2);
});
test('sleep inspection has no worker HTTP traffic, and health failures never become idle', async () => {
  const f = fixture(); f.replace({ state: 'exited', endpoint: null });
  const sleeping = parseAgentDetails(await f.service.details('docker:test', 'worker'));
  expect(workerStatus(sleeping.agent, sleeping, 100_000)).toBe('sleeping');
  expect(f.calls).toEqual([]);
  f.replace({ state: 'running', endpoint: 'http://127.0.0.1:8787' }); f.healthFail();
  const failed = await f.service.details('docker:test', 'worker');
  expect(failed.logs).toBe('saved logs'); expect(failed.agent.status?.health).toBeUndefined();
  expect(workerStatus(failed.agent, failed, 100_000)).toBe('unknown');
});
test.each(['restart', 'exit'])('health crossing same-container %s is discarded', async event => {
  const f = fixture();
  f.afterHealth(() => f.replace(event === 'restart'
    ? { startedAt: '2026-10-09T00:00:00.000000002Z' } : { state: 'exited' }));
  const result = await f.service.details('docker:test', 'worker');
  expect(result.agent.status).toBeUndefined();
  expect(workerStatus(result.agent, result, 100_000)).toBe('unknown');
});
test('malformed health and a missing execution identity cannot confirm work or idleness', async () => {
  const f = fixture();
  f.health({ role: 'development', ready: true, busy: 'false', threadId: null, error: null });
  expect((await f.service.details('docker:test', 'worker')).agent.status?.health).toBeUndefined();
  f.replace({ startedAt: undefined });
  expect((await f.service.details('docker:test', 'worker')).agent.status).toBeUndefined();
});

test('a slow response cannot renew an observation timestamp at completion', async () => {
  const f = fixture(); f.afterHealth(() => f.setNow(130_000));
  const result = await f.service.details('docker:test', 'worker');
  expect(result.agent.status?.observedAt).toBe(100_000);
  expect(workerStatus(result.agent, result, 130_000)).toBe('unknown');
});
