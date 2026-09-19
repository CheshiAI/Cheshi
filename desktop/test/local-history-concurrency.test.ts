import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LocalHistoryStore } from '../lib/local-history-store.mts';
import { withLocalHistoryLock } from '../lib/local-history-lock.mts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'cheshi-history-concurrency-'));
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, directory: path.join(workspaceRoot, 'history') };
}

function capture(content: string) {
  return { path: 'draft.txt', content, hasBom: false, lineEnding: 'lf' as const, reason: 'saved' as const };
}

interface WorkerOptions {
  workspaceRoot: string;
  directory: string;
  mode: 'capture' | 'hold';
  paths?: string[];
}

function startWorker(runtime: string, options: WorkerOptions) {
  const ready = createDeferred<void>();
  const result = createDeferred<string[]>();
  const exit = createDeferred<number | null>();
  const child: ChildProcess = spawn(runtime, [fileURLToPath(new URL('./local-history-process-fixture.mts', import.meta.url)), JSON.stringify(options)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let isReady = false;
  let receivedResult = false;
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('message', (message: unknown) => {
    if (message === null || typeof message !== 'object') return;
    if ('ready' in message && message.ready === true) { isReady = true; ready.resolve(); }
    if ('errors' in message && Array.isArray(message.errors) && message.errors.every(value => typeof value === 'string')) {
      receivedResult = true;
      result.resolve(message.errors);
    }
  });
  child.on('error', error => { ready.reject(error); result.reject(error); exit.reject(error); });
  child.on('exit', code => {
    exit.resolve(code);
    if (!isReady) ready.reject(new Error(`History worker failed before ready: ${stderr}`));
    if (!receivedResult && options.mode === 'capture') result.reject(new Error(`History worker exited without a result: ${stderr}`));
  });
  // Cleanup may kill a worker after an assertion fails; keep those rejections observed.
  void ready.promise.catch(() => undefined);
  void result.promise.catch(() => undefined);
  void exit.promise.catch(() => undefined);
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit.promise;
  });
  return { child, ready: ready.promise, result: result.promise, exit: exit.promise };
}

test('reloads committed records between store instances and serializes simultaneous calls', async () => {
  const options = await fixture();
  const first = new LocalHistoryStore(options);
  const second = new LocalHistoryStore(options);
  await first.list('draft.txt');
  await second.list('draft.txt');
  const initial = await first.capture(capture('initial'));
  const next = await second.capture(capture('next'));
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first : second).capture(capture(`concurrent-${index}`))));
  expect(await first.list('draft.txt')).toHaveLength(10);
  expect(await second.list('draft.txt')).toHaveLength(10);
  expect((await first.read('draft.txt', initial.id)).content).toBe('initial');
  expect((await second.read('draft.txt', next.id)).content).toBe('next');
  for (const [index, entry] of concurrent.entries()) {
    expect((await first.read('draft.txt', entry.id)).content).toBe(`concurrent-${index}`);
  }
});

test('retains all 120 snapshots when native Node and Bun app processes share history', async () => {
  const options = await fixture();
  const batches = [[], []] as [string[], string[]];
  for (let writer = 0; writer < 2; writer++) {
    for (let index = 0; index < 60; index++) {
      const name = `writer-${writer}-${index}.txt`;
      batches[writer]!.push(name);
      await writeFile(path.join(options.workspaceRoot, name), `${name}\n${'fixture data\n'.repeat(1000)}`);
    }
  }
  const workers = ['node', process.execPath].map((runtime, index) =>
    startWorker(runtime, { ...options, mode: 'capture', paths: batches[index]! }));
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send({ start: true });
  for (const errors of await Promise.all(workers.map(worker => worker.result))) expect(errors).toEqual([]);
  expect(await Promise.all(workers.map(worker => worker.exit))).toEqual([0, 0]);
  const store = new LocalHistoryStore(options);
  expect((await store.trackedPaths()).sort()).toEqual(batches.flat().sort());
  for (const name of batches.flat()) {
    const entries = await store.list(name);
    expect(entries).toHaveLength(1);
    expect((await store.read(name, entries[0]!.id)).content).toBe(await readFile(path.join(options.workspaceRoot, name), 'utf8'));
  }
  expect((await readdir(options.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
}, 15_000);

test('preserves a live writer temporary file and recovers the lock and orphans after SIGKILL', async () => {
  const options = await fixture();
  const store = new LocalHistoryStore(options);
  const saved = await store.capture(capture('durable'));
  const worker = startWorker('node', { ...options, mode: 'hold' });
  await worker.ready;
  let completed = false;
  const waiting = store.list('draft.txt').finally(() => { completed = true; });
  cleanups.push(() => waiting.catch(() => undefined));
  try {
    await delay(75);
    expect(completed).toBe(false);
    expect(await readFile(path.join(options.directory, 'history.json.12345678-1234-1234-1234-123456789012.tmp'), 'utf8')).toBe('interrupted');
  } finally {
    worker.child.kill('SIGKILL');
    await worker.exit;
  }
  expect((await waiting).map(entry => entry.id)).toEqual([saved.id]);
  expect((await store.read('draft.txt', saved.id)).content).toBe('durable');
  expect((await readdir(options.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect((await readdir(options.directory)).filter(name => name.endsWith('.txt'))).toHaveLength(1);
});

test('holds one lock through a compound restore transaction and releases it on failure', async () => {
  const options = await fixture();
  const store = new LocalHistoryStore({ ...options, maxEntries: 2 });
  const competing = new LocalHistoryStore({ ...options, maxEntries: 1 });
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  const transaction = store.transaction(async () => {
    const previous = await store.capture({ ...capture('previous'), reason: 'before-restore' });
    await store.ensureCaptureFits(capture('restored'), [previous.id]);
    started.resolve();
    await finish.promise;
    await store.capture({ ...capture('restored'), reason: 'restored' }, [previous.id]);
    expect((await store.read('draft.txt', previous.id)).content).toBe('previous');
  });
  await started.promise;
  let completed = false;
  const contender = competing.capture(capture('competing')).finally(() => { completed = true; });
  try {
    await delay(50);
    expect(completed).toBe(false);
  } finally {
    finish.resolve();
    await transaction;
    await contender;
  }
  const failure = new Error('operation failed');
  let caught: unknown;
  try { await withLocalHistoryLock(options.directory, async () => { throw failure; }); }
  catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect((await store.list('draft.txt')).map(entry => entry.reason)).toEqual(['saved']);
});
