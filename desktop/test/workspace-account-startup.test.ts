import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createWorkspaceAccountStartup } from '../lib/workspace-account-startup.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const setup = createDeferred<void>();
  const started = createDeferred<void>();
  const abort = new AbortController();
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const ipc: Pick<IpcMain, 'handle'> = { handle(channel, handler) { handlers.set(channel, handler); } };
  let initializations = 0;
  let trusted = true;
  const frame = {};
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const gate = createWorkspaceAccountStartup({
    ipc, signal: abort.signal,
    initialize: () => { initializations++; started.resolve(); return setup.promise; },
    assertSender: () => { if (!trusted) throw new Error('Untrusted sender'); },
  });
  const invoke = async (channel: string) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return await handler({ sender, senderFrame: frame } as IpcMainInvokeEvent);
  };
  return { gate, setup, started, abort, ipc, invoke, sender,
    get initializations() { return initializations; },
    setTrusted(value: boolean) { trusted = value; } };
}

test('account requests share startup and wait for selection; unrelated requests proceed', async () => {
  const f = fixture();
  let activeId = 'default';
  let calls = 0;
  f.gate.ipc.handle('account', () => { calls++; return activeId; });
  f.ipc.handle('files', () => 'files ready');
  const first = f.invoke('account');
  const second = f.invoke('account');
  const ready = f.gate.ready();
  await f.started.promise;
  assert.equal(await f.invoke('files'), 'files ready');
  assert.equal(calls, 0);
  assert.equal(f.initializations, 1);
  activeId = 'saved';
  f.setup.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['saved', 'saved']);
  await ready;
  await f.gate.ready();
  assert.equal(f.initializations, 1);
  f.abort.abort();
});

test('rejects untrusted senders before starting and rechecks ownership after waiting', async () => {
  const f = fixture();
  let calls = 0;
  f.gate.ipc.handle('account', () => calls++);
  f.setTrusted(false);
  await assert.rejects(f.invoke('account'), /Untrusted/);
  assert.equal(f.initializations, 0);
  f.setTrusted(true);
  const pending = f.invoke('account');
  await f.started.promise;
  f.setTrusted(false);
  f.setup.resolve();
  await assert.rejects(pending, /Untrusted/);
  assert.equal(calls, 0);
  f.abort.abort();
});

test('workspace shutdown releases pending requests without running their handlers', async () => {
  const f = fixture();
  let calls = 0;
  f.gate.ipc.handle('account', () => calls++);
  const pending = f.invoke('account');
  await f.started.promise;
  f.abort.abort(new Error('Workspace closed'));
  await assert.rejects(pending, /Workspace closed/);
  f.setup.resolve();
  await assert.rejects(f.gate.ready(), /Workspace closed/);
  assert.equal(calls, 0);
});

test('a renderer navigation while waiting cannot dispatch an old account request', async () => {
  const f = fixture();
  let calls = 0;
  f.gate.ipc.handle('account', () => calls++);
  const pending = f.invoke('account');
  await f.started.promise;
  f.sender.mainFrame = {};
  f.setup.resolve();
  await assert.rejects(pending, /no longer active/);
  assert.equal(calls, 0);
  f.abort.abort();
});

test('failed initialization is shared and cannot dispatch requests with the default account', async () => {
  const f = fixture();
  let calls = 0;
  f.gate.ipc.handle('account', () => calls++);
  const pending = f.invoke('account');
  await f.started.promise;
  f.setup.reject(new Error('Selection failed'));
  await assert.rejects(pending, /Selection failed/);
  await assert.rejects(f.invoke('account'), /Selection failed/);
  assert.equal(calls, 0);
  assert.equal(f.initializations, 1);
  f.abort.abort();
});

test('runtime begins loading the window while account selection is still pending', async () => {
  const source = readFileSync(new URL('../workspace-runtime.mts', import.meta.url), 'utf8');
  const start = source.indexOf('async function initialize():');
  const end = source.indexOf('let initialization:', start);
  assert.ok(start >= 0 && end > start);
  const f = fixture();
  const windowCreated = createDeferred<void>();
  let finished = false;
  const initialization = runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}\ninitialize();`, {
    accountSwitch: f.gate, initialIndexAbort: f.abort,
    logStartup: () => {}, options: { initial: true, deferShow: false },
    startupScreen: { setStatus: async () => {} },
    registerWorkspace: () => {}, userDataDirectory: '/data', workspaceRoot: '/workspace',
    codeGraphDatabasePath: '/index', codeGraphDataRoot: '/data', codeGraphCommands: { cli: () => ({}) },
    prepareInitialCodeGraph: async () => ({ ready: true }), startCodeGraphServer: async () => 'http://local',
    initializeWorkspaceFileWatcher: async () => {}, initializeGitRepositoryWatcher: async () => {},
    pendingIndexWarning: null, chatServiceOptions: { log: () => {} },
    createMainWindow: async () => { windowCreated.resolve(); await f.gate.ready(); return 'window'; },
  }) as Promise<unknown>;
  const completed = initialization.then(value => { finished = true; return value; });
  await windowCreated.promise;
  assert.equal(finished, false);
  assert.equal(f.initializations, 1);
  f.setup.resolve();
  assert.equal(await completed, 'window');
  // Actual reveal must retain both conditions, even if the renderer wins the race.
  assert.match(source, /await readiness\.ready;\s*await accountSwitch\.ready\(\);\s*if \(!options\.deferShow\) revealWindow\(\);/u);
  f.abort.abort();
});
