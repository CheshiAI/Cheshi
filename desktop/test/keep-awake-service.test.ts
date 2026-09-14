import assert from 'node:assert/strict';
import { ChildProcess, type spawn } from 'node:child_process';
import test from 'node:test';
import { KeepAwakeService } from '../lib/keep-awake-service.mts';

function fixture(options: { platform?: string; failStart?: boolean; stop?: 'force' | 'fail' } = {}) {
  const children: ChildProcess[] = [];
  const calls: unknown[][] = [];
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  let failStart = options.failStart;
  const service = new KeepAwakeService({ platform: options.platform ?? 'darwin', stopTimeoutMs: 5,
    spawn: ((...args: unknown[]) => {
      calls.push(args);
      const child = new ChildProcess();
      child.kill = signal => {
        signals.push(signal);
        if (options.stop !== 'fail' && (options.stop !== 'force' || signal === 'SIGKILL')) {
          queueMicrotask(() => child.emit('exit', null, signal));
        }
        return options.stop !== 'fail';
      };
      children.push(child);
      queueMicrotask(() => {
        if (failStart) { failStart = false; child.emit('error', new Error('spawn EACCES')); }
        else child.emit('spawn');
      });
      return child;
    }) as typeof spawn,
  });
  return { service, children, calls, signals };
}

test('starts the exact command once and stops only the owned process', async () => {
  const f = fixture();
  assert.equal(f.service.snapshot().enabled, false);
  const states = await Promise.all([f.service.setEnabled(true), f.service.setEnabled(true), f.service.setEnabled(true)]);
  assert.ok(states.every(state => state.enabled && !state.busy));
  assert.deepEqual(f.calls, [['/usr/bin/caffeinate', ['-d', '-i'], { stdio: 'ignore' }]]);
  assert.equal((await f.service.setEnabled(false)).enabled, false);
  assert.deepEqual(f.signals, ['SIGTERM']);
  await f.service.setEnabled(false);
  assert.equal(f.signals.length, 1);
  await f.service.dispose();
});

test('serializes conflicting requests and publishes the same revisions to each window', async () => {
  const f = fixture();
  const first: number[] = [];
  const second: number[] = [];
  const unsubscribe = f.service.subscribe(state => first.push(state.revision));
  f.service.subscribe(state => second.push(state.revision));
  const result = await Promise.all([f.service.setEnabled(true), f.service.setEnabled(false), f.service.setEnabled(true)]);
  assert.deepEqual(result.map(state => state.enabled), [true, false, true]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(first, second);
  assert.ok(first.every((value, index) => value > (first[index - 1] ?? 0)));
  unsubscribe();
  const count = first.length;
  await f.service.dispose();
  assert.equal(first.length, count);
  assert.ok(second.length > count);
});

test('spawn failures remain off, report the error and allow retry', async () => {
  const f = fixture({ failStart: true });
  await assert.rejects(f.service.setEnabled(true), /EACCES/);
  assert.equal(f.service.snapshot().enabled, false);
  assert.equal(f.service.snapshot().busy, false);
  assert.match(f.service.snapshot().error ?? '', /EACCES/);
  assert.equal((await f.service.setEnabled(true)).enabled, true);
  assert.equal(f.service.snapshot().error, null);
  await f.service.dispose();
});

test('unexpected exits switch off and old process events cannot clear a replacement', async () => {
  const f = fixture();
  await f.service.setEnabled(true);
  f.children[0]!.emit('exit', 1, null);
  assert.equal(f.service.snapshot().enabled, false);
  assert.match(f.service.snapshot().error ?? '', /unexpectedly/);
  await f.service.setEnabled(true);
  f.children[0]!.emit('error', new Error('stale process'));
  assert.equal(f.service.snapshot().enabled, true);
  assert.equal(f.service.snapshot().error, null);
  await f.service.dispose();
});

test('shutdown waits for queued startup, stops it and rejects further requests', async () => {
  const f = fixture();
  const start = f.service.setEnabled(true);
  const shutdown = f.service.dispose();
  await start;
  await shutdown;
  assert.equal(f.service.snapshot().enabled, false);
  assert.deepEqual(f.signals, ['SIGTERM']);
  await assert.rejects(f.service.setEnabled(true), /shutting down/);
  await f.service.dispose();
  assert.equal(f.signals.length, 1);
});

test('forces only the owned child when graceful termination does not finish', async () => {
  const f = fixture({ stop: 'force' });
  await f.service.setEnabled(true);
  await f.service.dispose();
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.service.snapshot().enabled, false);
});

test('does not report off or start a duplicate when termination cannot be confirmed', async () => {
  const f = fixture({ stop: 'fail' });
  await f.service.setEnabled(true);
  await assert.rejects(f.service.setEnabled(false), /confirm/);
  assert.equal(f.service.snapshot().enabled, true);
  assert.equal(f.service.snapshot().busy, false);
  await f.service.setEnabled(true);
  assert.equal(f.calls.length, 1);
  f.children[0]!.emit('exit', null, 'SIGKILL');
  await f.service.dispose();
});

test('rejects nonliteral boolean inputs and unsupported platforms without spawning', async () => {
  const f = fixture({ platform: 'linux' });
  assert.equal(f.service.snapshot().supported, false);
  for (const value of ['true', 1, null, {}, undefined]) await assert.rejects(f.service.setEnabled(value), /boolean/);
  await assert.rejects(f.service.setEnabled(true), /macOS/);
  assert.equal((await f.service.setEnabled(false)).enabled, false);
  await f.service.dispose();
  assert.equal(f.calls.length, 0);
});

test('failed shutdown leaves controls usable so termination can be retried', async () => {
  const f = fixture({ stop: 'fail' });
  await f.service.setEnabled(true);
  await assert.rejects(f.service.dispose(), /confirm/);
  assert.equal((await f.service.setEnabled(true)).enabled, true);
  f.children[0]!.emit('exit', null, 'SIGKILL');
  assert.equal((await f.service.setEnabled(false)).enabled, false);
  await f.service.dispose();
});
