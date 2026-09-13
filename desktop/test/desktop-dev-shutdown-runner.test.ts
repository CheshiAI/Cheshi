import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';

import { DEVELOPMENT_SHUTDOWN_DIRECTORY, stopDevelopmentProcess } from '../lib/development-shutdown.mts';

const runnerUrl = new URL('../../scripts/start-desktop-dev.mts', import.meta.url);
const require = createRequire(import.meta.url);
const runnerCode = ts.transpileModule(readFileSync(runnerUrl, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  transformers: {
    before: [(context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === 'url') {
          return ts.factory.createStringLiteral(runnerUrl.href);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as ts.SourceFile;
    }],
  },
}).outputText;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) =>
  (...args: unknown[]) => Promise<void>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'runner did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeChild extends EventEmitter {
  pid: number;
  kind: 'vite' | 'forge';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor(pid: number, kind: 'vite' | 'forge') {
    super();
    this.pid = pid;
    this.kind = kind;
  }

  close(signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = signal ? null : 0;
    this.signalCode = signal;
    this.emit('close', this.exitCode, signal);
  }

  kill(signal: NodeJS.Signals) { this.close(signal); return true; }
}

function createRunner(options: { holdPreload?: boolean; holdReadiness?: boolean; holdQuit?: boolean } = {}) {
  const preload = createDeferred<void>();
  const readiness = createDeferred<{ ok: boolean }>();
  const children: FakeChild[] = [];
  const events: string[] = [];
  const directories = new Map<string, FakeChild>();
  const signals = new EventEmitter();
  let changed: ((file: string) => void) | undefined;
  let requestId = 0;
  let requests = 0;
  let fetches = 0;
  let errors = '';
  const mockProcess = Object.assign(signals, {
    execPath: '/test/bun', platform: 'darwin', env: {}, exitCode: 0,
    stdout: { isTTY: false, write: () => true },
    stderr: { write: (value: string) => { errors += value; return true; } },
    kill: (pid: number, signal: NodeJS.Signals) => {
      const child = children.find((entry) => entry.pid === Math.abs(pid));
      assert.ok(child, 'only this launch process group may be signaled');
      events.push(`signal:${child.kind}:${signal}`);
      child.close(signal);
      return true;
    },
  });
  const imports: Record<string, unknown> = {
    'node:child_process': {
      spawn: (_executable: string, args: string[], configuration: { env: Record<string, string>; detached: boolean }) => {
        const kind = args.includes('electron-forge') ? 'forge' : 'vite';
        const child = new FakeChild(1_000 + children.length, kind);
        assert.equal(configuration.detached, true, 'terminal SIGINT must not reach child processes directly');
        children.push(child);
        events.push(`spawn:${kind}`);
        if (kind === 'forge') directories.set(configuration.env[DEVELOPMENT_SHUTDOWN_DIRECTORY]!, child);
        return child;
      },
    },
    'node:module': { createRequire: () => ({ resolve: () => '/test/vite/package.json' }) },
    'node:net': {
      createServer: () => Object.assign(new EventEmitter(), {
        listen: (_port: number, _host: string, ready: () => void) => queueMicrotask(ready),
        address: () => ({ port: 43_217 }),
        close: (closed?: () => void) => closed?.(),
      }),
    },
    './forward-desktop-dev-output.mts': { forwardDesktopDevOutput: () => {} },
    './build-desktop-preload.mts': { buildDesktopPreload: () => options.holdPreload ? preload.promise : Promise.resolve() },
    './watch-file-contents.mts': {
      watchFileContents: (_paths: string[], onChange: (file: string) => void) => {
        changed = onChange;
        return [{ close: () => events.push('watchers:closed') }];
      },
    },
    '../desktop/lib/development-shutdown.mts': {
      DEVELOPMENT_SHUTDOWN_DIRECTORY,
      createDevelopmentShutdownRequest: () => {
        const directory = `/test/shutdown-${++requestId}`;
        return {
          directory,
          request: () => {
            requests++;
            events.push('request:quit');
            if (!options.holdQuit) queueMicrotask(() => directories.get(directory)?.close());
          },
          dispose: () => events.push(`dispose:${directory}`),
        };
      },
      stopDevelopmentProcess: (configuration: Parameters<typeof stopDevelopmentProcess>[0]) => stopDevelopmentProcess({
        ...configuration, graceMs: 500, terminateMs: 20, killMs: 20,
      }),
    },
  };
  const completion = new AsyncFunction('require', 'exports', 'process', 'fetch', runnerCode)(
    (name: string) => name in imports ? imports[name] : require(name), {}, mockProcess,
    () => { fetches++; return options.holdReadiness ? readiness.promise : Promise.resolve({ ok: true }); },
  );
  return {
    children, events, completion,
    get requests() { return requests; },
    get fetches() { return fetches; },
    get errors() { return errors; },
    interrupt: () => signals.emit('SIGINT'),
    releasePreload: () => preload.resolve(),
    releaseReadiness: () => readiness.resolve({ ok: true }),
    changeSource: () => { assert.ok(changed); changed(new URL('../../desktop/main.mts', import.meta.url).pathname); },
    async cleanup() {
      signals.emit('SIGTERM');
      preload.resolve();
      readiness.resolve({ ok: true });
      for (const child of children) child.close();
      await completion;
    },
  };
}

test('Ctrl+C requests Electron quit and waits before stopping the renderer server', async (t) => {
  const runner = createRunner();
  t.after(() => runner.cleanup());
  await waitUntil(() => runner.children.length === 2);
  runner.interrupt();
  await runner.completion;
  assert.equal(runner.requests, 1);
  assert.deepEqual(runner.events.filter((event) => event.startsWith('request:') || event.startsWith('signal:')), [
    'request:quit', 'signal:vite:SIGTERM',
  ]);
  assert.equal(runner.errors, '');
});

test('Ctrl+C while preload builds prevents subsequent process launches', async (t) => {
  const runner = createRunner({ holdPreload: true });
  t.after(() => runner.cleanup());
  runner.interrupt();
  runner.releasePreload();
  await runner.completion;
  assert.equal(runner.children.length, 0);
  assert.equal(runner.errors, '');
});

test('Ctrl+C while renderer readiness is pending never launches Electron', async (t) => {
  const runner = createRunner({ holdReadiness: true });
  t.after(() => runner.cleanup());
  await waitUntil(() => runner.fetches === 1);
  runner.interrupt();
  runner.releaseReadiness();
  await runner.completion;
  assert.deepEqual(runner.children.map((child) => child.kind), ['vite']);
  assert.equal(runner.errors, '');
});

test('source restart waits for the previous launch and cannot restart after Ctrl+C', async (t) => {
  const runner = createRunner({ holdQuit: true });
  t.after(() => runner.cleanup());
  await waitUntil(() => runner.children.length === 2);
  runner.changeSource();
  await waitUntil(() => runner.requests === 1);
  assert.equal(runner.children.length, 2, 'old Electron still owns its workspace');
  runner.children[1]!.close();
  await waitUntil(() => runner.children.length === 3);
  runner.changeSource();
  await waitUntil(() => runner.requests === 2);
  runner.interrupt();
  runner.children[2]!.close();
  await runner.completion;
  assert.equal(runner.children.length, 3);
  assert.equal(runner.requests, 2, 'shutdown shares an in-flight graceful restart');
  assert.equal(runner.events.some((event) => event.startsWith('signal:forge:')), false);
  assert.equal(runner.errors, '');
});
