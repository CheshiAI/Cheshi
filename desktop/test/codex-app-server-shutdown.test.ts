import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import { shutdownCodexAppServer } from '../lib/codex-app-server-shutdown.mts';

function fakeChild(onSignal: (signal: NodeJS.Signals) => void = () => {}) {
  const signals: NodeJS.Signals[] = [];
  let unreferenced = false;
  const process = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal: NodeJS.Signals) { signals.push(signal); onSignal(signal); return true; },
    unref() { unreferenced = true; },
  });
  return {
    process, signals,
    // The injected boundary only implements the process operations used by shutdown.
    child: process as unknown as ChildProcessWithoutNullStreams,
    get unreferenced() { return unreferenced; },
  };
}

function clientFor(mode: string) {
  return new CodexAppServerClient({
    command: {
      executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-shutdown-server.mts', import.meta.url)), mode],
      environment: {},
    },
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    clientInfo: { name: 'shutdown-test', title: 'Shutdown test', version: '1' },
    shutdownTimeouts: { gracefulMs: 100, forceMs: 1000 },
  });
}

function trackSignals(child: ChildProcessWithoutNullStreams) {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const kill = child.kill.bind(child);
  child.kill = (signal) => { signals.push(signal); return kill(signal); };
  return signals;
}

test('an already exited child needs no signals or listeners', async () => {
  const fake = fakeChild();
  fake.process.exitCode = 0;
  await shutdownCodexAppServer(fake.child, { gracefulMs: 10, forceMs: 10 });
  assert.deepEqual(fake.signals, []);
  assert.equal(fake.process.listenerCount('exit'), 0);
});

test('waits for exit rather than treating a successful kill call as process termination', async () => {
  const fake = fakeChild(signal => {
    if (signal === 'SIGKILL') fake.process.emit('exit', null, signal);
  });
  await shutdownCodexAppServer(fake.child, { gracefulMs: 10, forceMs: 20 });
  assert.deepEqual(fake.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.process.listenerCount('exit'), 0);
  assert.equal(fake.process.listenerCount('error'), 0);
});

test('bounds failed force cleanup and releases listeners and pipe handles', async () => {
  const fake = fakeChild();
  await assert.rejects(shutdownCodexAppServer(fake.child, { gracefulMs: 10, forceMs: 10 }), /did not exit after SIGKILL/);
  assert.deepEqual(fake.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.process.listenerCount('exit'), 0);
  assert.equal(fake.process.listenerCount('error'), 0);
  assert(fake.process.stdin.destroyed && fake.process.stdout.destroyed && fake.process.stderr.destroyed);
  assert.equal(fake.unreferenced, true);
});

test('signal errors are reported and cannot start a replacement process', async () => {
  const fake = fakeChild(() => { throw new Error('Signal refused'); });
  const client = clientFor('graceful');
  client.child = fake.child;
  const stopped = client.stop();
  await assert.rejects(stopped, /Signal refused/);
  assert.equal(client.stop(), stopped);
  await assert.rejects(client.start(), /Signal refused/);
  assert.deepEqual(fake.signals, ['SIGTERM']);
  assert.equal(fake.process.listenerCount('exit'), 0);
});

test('native Node child exits gracefully without SIGKILL', async () => {
  const client = clientFor('graceful');
  try {
    await client.start();
    const child = client.child!;
    const signals = trackSignals(child);
    await client.stop();
    assert.equal(child.exitCode, 0);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(client.pid, null);
  } finally { await client.stop(); }
});

test('native child ignoring SIGTERM is killed; concurrent stop and restart wait for the owned child', async () => {
  const client = clientFor('ignore');
  try {
    await client.start();
    const child = client.child!;
    const signals = trackSignals(child);
    const first = client.stop();
    assert.equal(client.stop(), first);
    const restarted = client.start();
    assert.equal(client.pid, null);
    await first;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    await restarted;
    assert.notEqual(client.pid, child.pid);
    assert.equal(client.ready, true);
  } finally { await client.stop(); }
});

test('a stop during initialization settles before a replacement handshake starts', async () => {
  const client = clientFor('hold');
  const ready = new Promise<void>(resolve => {
    client.onNotification(event => { if (event.method === 'fixture/ready') resolve(); });
  });
  const initializing = client.start();
  const interrupted = assert.rejects(initializing, {
    name: 'CodexAppServerStoppedError', message: /Codex App Server stopped/,
  });
  const child = client.child!;
  try {
    await ready;
    const stopped = client.stop();
    client.command.args[1] = 'graceful';
    const replacement = client.start();
    await interrupted;
    await stopped;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.deepEqual(await replacement, { userAgent: 'shutdown-test' });
    assert.notEqual(client.pid, child.pid);
  } finally { await client.stop(); }
});

for (const [mode, message] of [['malformed', 'returned invalid JSON'], ['rejected', 'Initialization refused']]) {
  test(`native initialization failure still cleans up a SIGTERM-resistant child: ${mode}`, async () => {
    const client = clientFor(mode!);
    const starting = client.start();
    const child = client.child!;
    try {
      await assert.rejects(starting, new RegExp(message!));
      await client.stop();
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(client.pid, null);
    } finally { await client.stop(); }
  });
}
