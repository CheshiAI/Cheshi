import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  createDevelopmentShutdownRequest,
  stopDevelopmentProcess,
  watchDevelopmentShutdown,
  signalDevelopmentApp,
} from '../lib/development-shutdown.mts';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const shortTimeouts = { graceMs: 15, terminateMs: 15, killMs: 15 };

test('normal shutdown waits for quit completion without signaling the process', async () => {
  const completion = createDeferred();
  const events: string[] = [];
  const stopping = stopDevelopmentProcess({
    completion: completion.promise,
    requestQuit: () => { events.push('quit'); completion.resolve(); },
    signal: (signal) => { events.push(signal); },
    ...shortTimeouts,
  });
  await stopping;
  assert.deepEqual(events, ['quit']);
});

test('already completed or failed processes do not receive a new quit request', async () => {
  for (const completion of [Promise.resolve(), Promise.reject(new Error('spawn failed'))]) {
    const events: string[] = [];
    await stopDevelopmentProcess({
      completion,
      requestQuit: () => { events.push('quit'); },
      signal: (signal) => { events.push(signal); },
      ...shortTimeouts,
    });
    assert.deepEqual(events, []);
  }
});

test('an unresponsive quit request escalates to termination and stops after completion', async () => {
  const completion = createDeferred();
  const requested = createDeferred();
  const events: string[] = [];
  const stopping = stopDevelopmentProcess({
    completion: completion.promise,
    requestQuit: () => { events.push('quit'); requested.resolve(); },
    signal: (signal) => { events.push(signal); completion.resolve(); },
    ...shortTimeouts,
  });
  await requested.promise;
  assert.deepEqual(events, ['quit'], 'termination must wait for the graceful shutdown interval');
  await stopping;
  assert.deepEqual(events, ['quit', 'SIGTERM']);
});

test('a failed quit request still falls back to process termination', async () => {
  const completion = createDeferred();
  const events: string[] = [];
  await stopDevelopmentProcess({
    completion: completion.promise,
    requestQuit: () => { events.push('quit'); throw new Error('listener unavailable'); },
    signal: (signal) => { events.push(signal); completion.resolve(); },
    ...shortTimeouts,
  });
  assert.deepEqual(events, ['quit', 'SIGTERM']);
});

test('ignored termination escalates to kill only after requesting graceful exit and termination', async () => {
  const completion = createDeferred();
  const events: string[] = [];
  await stopDevelopmentProcess({
    completion: completion.promise,
    requestQuit: () => { events.push('quit'); },
    signal: (signal) => {
      events.push(signal);
      if (signal === 'SIGKILL') completion.resolve();
    },
    ...shortTimeouts,
  });
  assert.deepEqual(events, ['quit', 'SIGTERM', 'SIGKILL']);
});

test('a process that never completes reports bounded forced shutdown failure', { timeout: 5_000 }, async () => {
  const events: string[] = [];
  await assert.rejects(stopDevelopmentProcess({
    completion: createDeferred().promise,
    requestQuit: () => { events.push('quit'); },
    signal: (signal) => { events.push(signal); },
    ...shortTimeouts,
  }), /did not exit after forced shutdown/);
  assert.deepEqual(events, ['quit', 'SIGTERM', 'SIGKILL']);
});

test('a shutdown request written before listener startup is delivered exactly once', async (context) => {
  const request = createDevelopmentShutdownRequest();
  context.after(() => request.dispose());
  request.request();
  let calls = 0;
  const stopWatching = watchDevelopmentShutdown(request.directory, () => { calls += 1; });
  context.after(stopWatching);
  assert.equal(calls, 1);
  request.request();
  await delay(40);
  assert.equal(calls, 1);
});

test('live requests only stop their own launch and duplicate requests are ignored', { timeout: 5_000 }, async (context) => {
  const first = createDevelopmentShutdownRequest();
  const second = createDevelopmentShutdownRequest();
  context.after(() => { first.dispose(); second.dispose(); });
  assert.notEqual(first.directory, second.directory);
  const notified = createDeferred();
  let firstCalls = 0;
  let secondCalls = 0;
  const stopFirst = watchDevelopmentShutdown(first.directory, () => {
    firstCalls += 1;
    notified.resolve();
  });
  const stopSecond = watchDevelopmentShutdown(second.directory, () => { secondCalls += 1; });
  context.after(() => { stopFirst(); stopSecond(); });
  first.request();
  await notified.promise;
  first.request();
  await delay(40);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
});

test('disposing a listener prevents subsequent delivery and request cleanup removes its directory', async (context) => {
  const request = createDevelopmentShutdownRequest();
  context.after(() => request.dispose());
  let calls = 0;
  const stopWatching = watchDevelopmentShutdown(request.directory, () => { calls += 1; });
  stopWatching();
  request.request();
  await delay(40);
  assert.equal(calls, 0);
  request.dispose();
  assert.equal(existsSync(request.directory), false);
  request.dispose();
});

test('an absent or relative control directory leaves the listener disabled', () => {
  for (const directory of [undefined, '', 'relative/path']) {
    const stopWatching = watchDevelopmentShutdown(directory, () => assert.fail('unexpected quit'));
    stopWatching();
  }
});

test('forced macOS shutdown requires this bundle and the original process birth time', (context) => {
  const request = createDevelopmentShutdownRequest();
  context.after(() => request.dispose());
  const executable = '/checkout/Cheshi Development.app/Contents/MacOS/Electron';
  const identity = `Tue Sep 22 10:00:00 2026 ${executable}`;
  const calls: Array<[number, string | number | undefined]> = [];
  const kill: typeof process.kill = (pid, signal) => { calls.push([pid, signal]); return true; };
  const receipt = (pid: number, value: string) => writeFileSync(path.join(request.directory, 'process.json'), JSON.stringify({ pid, identity: value }));
  receipt(123, identity);
  signalDevelopmentApp(request.directory, executable, 'SIGTERM', () => identity, kill);
  assert.deepEqual(calls, [[123, 'SIGTERM']]);
  assert.throws(() => signalDevelopmentApp(request.directory, executable, 'SIGKILL', () => identity.replace('10:00', '11:00'), kill), /identity has changed/);
  receipt(123, 'another app');
  assert.throws(() => signalDevelopmentApp(request.directory, executable, 'SIGKILL', () => identity, kill), /Cannot identify/);
  receipt(-123, identity);
  assert.throws(() => signalDevelopmentApp(request.directory, executable, 'SIGKILL', () => identity, kill), /Cannot identify/);
  assert.equal(calls.length, 1);
});
