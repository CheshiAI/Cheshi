import { expect, test } from 'bun:test';
import { createWorkerOperations, deletionReply, WorkerOperationBusyError } from '../lib/agent-management/operations.mts';
import { registryDeferred as createDeferred } from './agent-registry-fixtures';
import { unwrapAgentDeletion } from '../shared/agent-management';

test('deletion waits for all overlapping work, reserves the lock and runs exactly once', async () => {
  const operations = createWorkerOperations(), a = createDeferred<void>(), b = createDeferred<void>(), release = createDeferred<void>();
  const first = operations.run(() => a.promise), second = operations.run(() => b.promise);
  let calls = 0;
  const deletion = operations.exclusive(async () => { calls++; await release.promise; return 'deleted'; });
  expect(calls).toBe(0);
  const duplicate = await deletionReply(() => operations.exclusive(async () => { calls++; }));
  expect(duplicate.status).toBe('busy');
  a.resolve(); await first; expect(calls).toBe(0);
  b.resolve(); await second;
  expect(() => operations.assertAvailable()).toThrow(WorkerOperationBusyError);
  expect(calls).toBe(1);
  release.resolve(); expect(await deletion).toBe('deleted');
  expect(await operations.run(async () => 'available')).toBe('available');
});

test('timed-out deletion never runs later and a fresh retry succeeds', async () => {
  const operations = createWorkerOperations(20), gate = createDeferred<void>();
  const running = operations.run(() => gate.promise);
  let calls = 0;
  try {
    const result = await deletionReply(() => operations.exclusive(async () => { calls++; }));
    expect(result.status).toBe('busy');
    expect(() => unwrapAgentDeletion(result)).toThrow('Nothing was deleted');
    expect(calls).toBe(0);
    gate.resolve(); await running; await Promise.resolve(); expect(calls).toBe(0);
    expect(await deletionReply(() => operations.exclusive(async () => ++calls))).toEqual({ status: 'deleted', value: 1 });
  } finally { gate.resolve(); await running; }
});

test('operation rejection releases waiting deletion and genuine deletion errors are not hidden', async () => {
  const operations = createWorkerOperations(), gate = createDeferred<void>();
  const failure = new Error('real failure');
  const running = operations.run(() => gate.promise).catch(error => error);
  const deletion = operations.exclusive(async () => { throw failure; }).catch(error => error);
  gate.reject(failure);
  expect(await running).toBe(failure); expect(await deletion).toBe(failure);
  let observed: unknown;
  try { await deletionReply(async () => { throw failure; }); } catch (error) { observed = error; }
  expect(observed).toBe(failure);
  expect(await operations.exclusive(async () => 'retry')).toBe('retry');
  expect(() => unwrapAgentDeletion({ status: 'unknown' })).toThrow('Invalid deletion');
});
