import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as spawnChild } from 'node:child_process';
import { createKeepAwakeService } from '../lib/keep-awake.mts';
import { parseKeepAwakeState, type KeepAwakeState } from '../shared/keep-awake';

class FakeChild extends EventEmitter {
  signals: string[] = [];
  autoExit = true;
  kill(signal: string) {
    this.signals.push(signal);
    if (this.autoExit) queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

function fixture(autoSpawn = true) {
  const children: FakeChild[] = [];
  const calls: unknown[][] = [];
  const spawn = ((...args: unknown[]): ChildProcess => {
    calls.push(args);
    const child = new FakeChild();
    children.push(child);
    if (autoSpawn) queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  }) as typeof spawnChild;
  const service = createKeepAwakeService({ platform: 'darwin', spawn, stopTimeoutMs: 5, startTimeoutMs: 20 });
  return { service, children, calls, spawn };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(message);
}

describe('keep-awake process ownership', () => {
  test('starts the exact command without a shell and stops only its own child', async () => {
    const { service, calls, children } = fixture();
    expect(service.snapshot()).toEqual({ supported: true, enabled: false, error: null });
    expect((await service.setEnabled(true)).enabled).toBe(true);
    expect(calls).toEqual([['/usr/bin/caffeinate', ['-d', '-i'], { stdio: 'ignore', shell: false }]]);
    await service.setEnabled(true);
    expect(calls).toHaveLength(1);
    expect((await service.setEnabled(false)).enabled).toBe(false);
    expect(children[0]!.signals).toEqual(['SIGTERM']);
    await service.dispose();
  });

  test('waits for spawn and actual exit before changing the enabled state', async () => {
    const { service, children } = fixture(false);
    const starting = service.setEnabled(true);
    await Promise.resolve();
    expect(service.snapshot().enabled).toBe(false);
    children[0]!.emit('spawn');
    await starting;
    children[0]!.autoExit = false;
    const stopping = service.setEnabled(false);
    await Promise.resolve();
    expect(service.snapshot().enabled).toBe(true);
    children[0]!.emit('exit', null, 'SIGTERM');
    expect((await stopping).enabled).toBe(false);
    await service.dispose();
  });

  test('serializes rapid toggles without leaving duplicate processes', async () => {
    const { service, children } = fixture();
    const states = await Promise.all([service.setEnabled(true), service.setEnabled(false), service.setEnabled(true)]);
    expect(states.map(state => state.enabled)).toEqual([true, false, true]);
    expect(children).toHaveLength(2);
    expect(children[0]!.signals).toEqual(['SIGTERM']);
    expect(children[1]!.signals).toEqual([]);
    await service.dispose();
    expect(children[1]!.signals).toEqual(['SIGTERM']);
    await expectFailure(service.setEnabled(true), 'closed');
  });

  test('broadcasts unexpected exit and allows a fresh start', async () => {
    const { service, children } = fixture();
    const updates: KeepAwakeState[] = [];
    const unsubscribe = service.subscribe(state => updates.push(state));
    await service.setEnabled(true);
    children[0]!.emit('exit', 1, null);
    expect(updates.at(-1)?.enabled).toBe(false);
    expect(updates.at(-1)?.error).toContain('unexpectedly');
    await service.setEnabled(true);
    expect(children).toHaveLength(2);
    unsubscribe();
    await service.dispose();
    expect(updates.at(-1)?.enabled).toBe(true);
  });

  test('reports spawn failure without leaving enabled state or blocking retry', async () => {
    const { service, children } = fixture(false);
    const starting = service.setEnabled(true);
    await Promise.resolve();
    children[0]!.emit('error', new Error('ENOENT'));
    const state = await starting;
    expect(state.enabled).toBe(false);
    expect(state.error).toBe('ENOENT');
    const retry = service.setEnabled(true);
    await Promise.resolve();
    children[1]!.emit('spawn');
    expect((await retry).enabled).toBe(true);
    await service.dispose();
  });

  test('escalates only its owned process when termination stalls and remains honest on failure', async () => {
    const { service, children } = fixture();
    await service.setEnabled(true);
    children[0]!.autoExit = false;
    const state = await service.setEnabled(false);
    expect(children[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(state.enabled).toBe(true);
    expect(state.error).toContain('did not stop');
    children[0]!.autoExit = true;
    expect((await service.setEnabled(false)).enabled).toBe(false);
    await service.dispose();
  });

  test('does not spawn for unsupported platforms or invalid input', async () => {
    const { spawn, calls } = fixture();
    const service = createKeepAwakeService({ platform: 'linux', spawn });
    expect(await service.setEnabled(true)).toEqual({ supported: false, enabled: false, error: 'Keep awake is available on macOS only.' });
    for (const input of ['true', 1, null, {}, undefined]) await expectFailure(service.setEnabled(input), 'boolean');
    expect(calls).toHaveLength(0);
    await service.dispose();
  });

  test('updates disabled state when exit arrives after the stop timeout', async () => {
    const { service, children } = fixture();
    await service.setEnabled(true);
    children[0]!.autoExit = false;
    expect((await service.setEnabled(false)).enabled).toBe(true);
    children[0]!.emit('exit', null, 'SIGKILL');
    expect(service.snapshot()).toEqual({ supported: true, enabled: false, error: null });
    await service.dispose();
  });

  test('reports disposal failure when its process cannot be stopped', async () => {
    const { service, children } = fixture();
    await service.setEnabled(true);
    children[0]!.autoExit = false;
    await expectFailure(service.dispose(), 'did not stop');
    expect(service.snapshot().enabled).toBe(true);
    children[0]!.emit('exit', null, 'SIGKILL');
    expect(service.snapshot().enabled).toBe(false);
  });

  test('snapshot and subscriber copies cannot mutate service state', async () => {
    const { service } = fixture();
    service.subscribe(state => { state.enabled = false; });
    await service.setEnabled(true);
    const state = service.snapshot();
    state.enabled = false;
    expect(service.snapshot().enabled).toBe(true);
    await service.dispose();
  });
});

test('keep-awake state validation rejects malformed and contradictory values', () => {
  const valid = { supported: true, enabled: false, error: null };
  expect(parseKeepAwakeState(valid)).toEqual(valid);
  expect(parseKeepAwakeState(valid)).not.toBe(valid);
  for (const input of [null, [], {}, { ...valid, enabled: 'true' }, { ...valid, supported: 1 },
    { ...valid, error: false }, { ...valid, extra: true }, { supported: false, enabled: true, error: null }]) {
    expect(() => parseKeepAwakeState(input)).toThrow(TypeError);
  }
});
