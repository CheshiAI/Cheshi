import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BaseWindow, BrowserWindow, MessageBoxSyncOptions } from 'electron';
import {
  closeWorkspaceWindow, registerWorkspaceWindowCloseConfirmation, WorkspaceApplication,
  WorkspaceWindowCloseCancelledError, type WorkspaceRuntimeOptions, type WorkspaceRuntime,
} from '../lib/workspace-application.mts';
import { WorkspaceIpcRouter } from '../lib/workspace-ipc-router.mts';

function fixture() {
  const instances: Array<WorkspaceRuntime & {
    options: WorkspaceRuntimeOptions; window: BrowserWindow;
    state: { destroyed: boolean; blocked: boolean; disposed: number; closeCalls: number; shown: boolean };
  }> = [];
  const liveScopes = new Set<object>();
  const router = new WorkspaceIpcRouter({ handle() {}, removeHandler() {}, on() { return this as never; }, off() { return this as never; } });
  let failNextRoot: string | null = null;
  let nextStartGate: Promise<void> | null = null;
  const eventsLog: string[] = [];
  const confirmations: MessageBoxSyncOptions[] = [];
  let closeChoice = 0;
  function createRuntime(options: WorkspaceRuntimeOptions) {
    const events = new EventEmitter();
    const contents = new EventEmitter();
    const state = { destroyed: false, blocked: false, disposed: 0, closeCalls: 0, shown: false };
    const startGate = nextStartGate;
    nextStartGate = null;
    const window = {
      webContents: contents,
      once: events.once.bind(events), off: events.off.bind(events),
      isDestroyed: () => state.destroyed,
      getNormalBounds: () => ({ x: 120, y: 80, width: 1500, height: 950 }),
      isMaximized: () => false, isFullScreen: () => false,
      close() {
        state.closeCalls += 1;
        if (state.blocked) {
          const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
          contents.emit('will-prevent-unload', event);
          if (!event.defaultPrevented) return;
        }
        state.destroyed = true;
        eventsLog.push(`closed:${options.workspaceRoot}`);
        options.onClosed();
        events.emit('closed');
      },
    } as unknown as BrowserWindow;
    registerWorkspaceWindowCloseConfirmation(window, {
      showMessageBoxSync(parent: BaseWindow | MessageBoxSyncOptions, configuration?: MessageBoxSyncOptions) {
        assert.equal(parent, window);
        assert.ok(configuration);
        confirmations.push(configuration);
        return closeChoice;
      },
    });
    liveScopes.add(options.scope);
    const runtime = {
      options, state, window,
      async start() {
        if (startGate) await startGate;
        if (failNextRoot === options.workspaceRoot) { failNextRoot = null; throw new Error('Startup failed'); }
        if (state.disposed) throw new Error('Startup canceled');
        state.shown = options.deferShow !== true;
        return window;
      },
      show() { state.shown = true; eventsLog.push(`shown:${options.workspaceRoot}`); },
      async dispose() {
        state.disposed += 1;
        state.destroyed = true;
        eventsLog.push(`disposed:${options.workspaceRoot}`);
        liveScopes.delete(options.scope);
        options.scope.dispose();
      },
    };
    instances.push(runtime);
    return runtime;
  }
  const application = new WorkspaceApplication({ router, createRuntime, initialRoot: '/one' });
  return { application, instances, liveScopes, eventsLog, confirmations,
    chooseClose(choice: number) { closeChoice = choice; },
    gateNextStart(promise: Promise<void>) { nextStartGate = promise; },
    failNext(root: string) { failNextRoot = root; } };
}

test('new workspaces are independent windows in one application with only the first marked initial', async () => {
  const f = fixture();
  await f.application.open('/one');
  await f.instances[0]!.options.onOpenWorkspace('/two');
  await f.instances[1]!.options.onOpenWorkspace('/three');
  assert.deepEqual(f.instances.map((entry) => [entry.options.workspaceRoot, entry.options.initial]),
    [['/one', true], ['/two', false], ['/three', false]]);
  assert.equal(f.liveScopes.size, 3);
  assert.notEqual(f.instances[0]!.options.scope, f.instances[1]!.options.scope);
  assert.equal(f.instances[0]!.state.closeCalls, 0);
  await f.application.closeAll();
  assert.equal(f.liveScopes.size, 0);
});

test('replacing a workspace closes only the source window and preserves its geometry', async () => {
  const f = fixture();
  await f.application.open('/one');
  await f.application.open('/other');
  const switching = f.instances[0]!.options.onReplaceWorkspace('/replacement');
  assert.equal(f.application.isTransitioning, true);
  await switching;
  assert.equal(f.application.isTransitioning, false);
  assert.equal(f.instances[0]!.state.destroyed, true);
  assert.equal(f.instances[0]!.state.disposed, 1);
  assert.equal(f.instances[1]!.state.closeCalls, 0);
  assert.equal(f.instances[2]!.options.initial, false);
  assert.deepEqual(f.instances[2]!.options.windowState, {
    bounds: { x: 120, y: 80, width: 1500, height: 950 }, maximized: false, fullscreen: false,
  });
  assert.equal(f.liveScopes.size, 2);
  await f.application.closeAll();
});

test('same workspace and unsaved files preserve the source and discard any hidden replacement', async () => {
  const f = fixture();
  await f.application.open('/one');
  const source = f.instances[0]!;
  await assert.rejects(source.options.onReplaceWorkspace('/one'), /already open/u);
  source.state.blocked = true;
  await assert.rejects(source.options.onReplaceWorkspace('/two'), /unsaved files/u);
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[1]!.state.disposed, 1);
  assert.equal(f.instances[1]!.state.shown, false);
  assert.equal(source.state.disposed, 0);
  assert.equal(f.application.lastWorkspaceRoot, '/one');
  source.state.blocked = false;
  await source.options.onReplaceWorkspace('/two');
  assert.equal(f.instances.length, 3);
  await f.application.closeAll();
});

test('failed replacement keeps the original workspace alive without recreating it', async () => {
  const f = fixture();
  await f.application.open('/one');
  await f.application.open('/other');
  f.failNext('/broken');
  await assert.rejects(f.instances[0]!.options.onReplaceWorkspace('/broken'), /Startup failed/u);
  assert.equal(f.instances.length, 3);
  assert.equal(f.instances[0]!.state.closeCalls, 0);
  assert.equal(f.instances[0]!.state.disposed, 0);
  assert.equal(f.instances[2]!.state.disposed, 1);
  assert.equal(f.application.lastWorkspaceRoot, '/other');
  assert.equal(f.instances[1]!.state.disposed, 0);
  assert.equal(f.liveScopes.size, 2);
  await f.application.closeAll();
});

test('failed startup releases its scope and closing all can be canceled then retried', async () => {
  const f = fixture();
  f.failNext('/broken');
  await assert.rejects(f.application.open('/broken'), /Startup failed/u);
  assert.equal(f.liveScopes.size, 0);
  assert.equal(f.application.hasWorkspaces, false);
  await f.application.open('/one');
  f.instances.at(-1)!.state.blocked = true;
  await assert.rejects(f.application.closeAll(), WorkspaceWindowCloseCancelledError);
  assert.equal(f.application.hasWorkspaces, true);
  f.instances.at(-1)!.state.blocked = false;
  await f.application.closeAll();
  assert.equal(f.application.hasWorkspaces, false);
  assert.equal(f.liveScopes.size, 0);
});

test('closing a clean workspace does not ask to discard changes', async () => {
  const f = fixture();
  await f.application.open('/one');
  await f.application.closeAll();
  assert.deepEqual(f.confirmations, []);
});

test('native close preserves unsaved files by default and allows an explicit discard', async () => {
  const f = fixture();
  await f.application.open('/one');
  const source = f.instances[0]!;
  source.state.blocked = true;
  source.window.close();
  assert.equal(source.state.destroyed, false);
  assert.equal(source.state.disposed, 0);
  assert.equal(f.confirmations[0]!.defaultId, 0);
  assert.equal(f.confirmations[0]!.cancelId, 0);
  assert.deepEqual(f.confirmations[0]!.buttons, ['Cancel', 'Discard Changes']);
  f.chooseClose(1);
  source.window.close();
  await f.application.closeAll();
  assert.equal(source.state.destroyed, true);
  assert.equal(source.state.disposed, 1);
  assert.equal(source.window.webContents.listenerCount('will-prevent-unload'), 0);
});

test('app quit waits for discarded windows to close and releases their services', async () => {
  const f = fixture();
  await f.application.open('/one');
  await f.application.open('/two');
  for (const source of f.instances) source.state.blocked = true;
  f.chooseClose(1);
  await f.application.closeAll();
  assert.equal(f.confirmations.length, 2);
  assert.equal(f.application.hasWorkspaces, false);
  assert.equal(f.liveScopes.size, 0);
  assert.deepEqual(f.instances.map((source) => source.state.disposed), [1, 1]);
});

test('discarding changes commits a prepared workspace switch', async () => {
  const f = fixture();
  await f.application.open('/one');
  const source = f.instances[0]!;
  source.state.blocked = true;
  f.chooseClose(1);
  await source.options.onReplaceWorkspace('/two');
  assert.deepEqual(f.eventsLog.slice(0, 3), ['closed:/one', 'shown:/two', 'disposed:/one']);
  assert.equal(f.application.lastWorkspaceRoot, '/two');
  assert.equal(f.liveScopes.size, 1);
  await f.application.closeAll();
});

test('unexpected confirmation choices preserve drafts and permit retry after cancellation', async () => {
  const f = fixture();
  await f.application.open('/one');
  const source = f.instances[0]!;
  source.state.blocked = true;
  let closed = 0;
  for (const choice of [-1, 2]) {
    f.chooseClose(choice);
    await assert.rejects(closeWorkspaceWindow(source.window, () => { closed += 1; }), WorkspaceWindowCloseCancelledError);
    assert.equal(source.state.destroyed, false);
    assert.equal(closed, 0);
    assert.equal(source.window.webContents.listenerCount('will-prevent-unload'), 1);
  }
  f.chooseClose(1);
  await closeWorkspaceWindow(source.window, () => { closed += 1; });
  assert.equal(closed, 1);
  await f.application.closeAll();
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('the initial manager owns no project and does not block deleting catalog folders', async () => {
  const f = fixture();
  await f.application.openManager();
  const manager = f.instances[0]!;
  assert.equal(manager.options.managementOnly, true);
  assert.equal(manager.options.workspaceRoot, '');
  assert.equal(f.application.lastWorkspaceRoot, '/one');
  assert.equal(f.application.hasWorkspaces, true);
  assert.equal(await manager.options.withWorkspaceDeletion('/one', async () => true), true);
  await manager.options.onReplaceWorkspace('/chosen');
  const chosen = f.instances[1]!;
  assert.equal(chosen.options.managementOnly, false);
  assert.equal(chosen.options.workspaceRoot, '/chosen');
  assert.equal(chosen.options.windowState, undefined);
  assert.equal(f.application.lastWorkspaceRoot, '/chosen');
  // IPC closes the manager only once the chosen workspace has opened.
  assert.equal(manager.state.destroyed, false);
  await assert.rejects(manager.options.withWorkspaceDeletion('/chosen', async () => true), /Close all workspace windows/u);
  await f.application.closeAll();
  assert.equal(f.liveScopes.size, 0);
});

test('a failed initial workspace selection keeps the manager available for retry', async () => {
  const f = fixture();
  await f.application.openManager();
  f.failNext('/broken');
  await assert.rejects(f.instances[0]!.options.onReplaceWorkspace('/broken'), /Startup failed/u);
  assert.equal(f.instances[0]!.state.destroyed, false);
  assert.equal(f.liveScopes.size, 1);
  await f.instances[0]!.options.onOpenWorkspace('/retry');
  assert.equal(f.application.lastWorkspaceRoot, '/retry');
  await f.application.closeAll();
});

test('deletion blocks active folders and their parents or children across all windows', async () => {
  const f = fixture();
  await f.application.open('/projects/one');
  await f.application.open('/other/two');
  const remove = f.instances[0]!.options.withWorkspaceDeletion;
  let deletes = 0;
  for (const root of ['/projects/one', '/projects', '/projects/one/child', '/other/two']) {
    await assert.rejects(remove(root, async () => { deletes++; return true; }), /Close all workspace windows/u);
  }
  assert.equal(deletes, 0);
  assert.equal(await remove('/projects/one-more', async () => true), true);
  assert.equal(f.instances[0]!.state.closeCalls, 0);
  await f.application.closeAll();
});

test('deletion reserves a folder until cancellation or failure and prevents opening or switching into it', async () => {
  const f = fixture();
  await f.application.open('/one');
  const options = f.instances[0]!.options;
  const gate = createDeferred();
  const deleting = options.withWorkspaceDeletion('/target', async () => { await gate.promise; return false; });
  await assert.rejects(f.application.open('/target/child'), /being deleted/u);
  await assert.rejects(options.onReplaceWorkspace('/target'), /being deleted/u);
  await assert.rejects(options.withWorkspaceDeletion('/target', async () => true), /being deleted/u);
  assert.throws(() => options.assertWorkspaceAvailable('/target'), /being deleted/u);
  assert.equal(f.instances[0]!.state.closeCalls, 0);
  gate.resolve();
  assert.equal(await deleting, false);
  await assert.rejects(options.withWorkspaceDeletion('/target', async () => { throw new Error('Trash failed'); }), /Trash failed/u);
  await f.application.open('/target');
  assert.equal(f.instances.length, 2);
  await f.application.closeAll();
});

test('deletion stays blocked while a closed workspace is disposing its services', async () => {
  const f = fixture();
  await f.application.open('/one');
  await f.application.open('/two');
  const closing = f.instances[1]!;
  const gate = createDeferred();
  const dispose = closing.dispose.bind(closing);
  closing.dispose = async () => { await gate.promise; await dispose(); };
  closing.window.close();
  const remove = f.instances[0]!.options.withWorkspaceDeletion;
  await assert.rejects(remove('/two', async () => true), /Close all workspace windows/u);
  gate.resolve();
  await f.application.closeAll();
  assert.equal(await remove('/two', async () => true), true);
});

test('failed service disposal keeps the workspace protected from deletion', async () => {
  const f = fixture();
  await f.application.open('/one');
  const entry = f.instances[0]!;
  entry.dispose = async () => { throw new Error('Service still running'); };
  await assert.rejects(f.application.closeAll(), /Service still running/u);
  await assert.rejects(entry.options.withWorkspaceDeletion('/one', async () => true), /Close all workspace windows/u);
});


test('replacement waits for readiness with the source visible and rejects concurrent switches', async () => {
  const f = fixture();
  await f.application.open('/one');
  const gate = createDeferred();
  f.gateNextStart(gate.promise);
  const source = f.instances[0]!;
  const switching = source.options.onReplaceWorkspace('/two');
  const replacement = f.instances[1]!;
  assert.equal(source.state.closeCalls, 0);
  assert.equal(source.state.shown, true);
  assert.equal(replacement.options.deferShow, true);
  assert.equal(replacement.state.shown, false);
  assert.equal(f.application.lastWorkspaceRoot, '/one');
  await assert.rejects(source.options.onReplaceWorkspace('/three'), /already in progress/u);
  gate.resolve();
  await switching;
  assert.equal(replacement.state.shown, true);
  assert.deepEqual(f.eventsLog.slice(0, 3), ['closed:/one', 'shown:/two', 'disposed:/one']);
  assert.equal(f.application.lastWorkspaceRoot, '/two');
  await f.application.closeAll();
});

test('replacement is shown before slow source service cleanup finishes', async () => {
  const f = fixture();
  await f.application.open('/one');
  const source = f.instances[0]!;
  const disposing = createDeferred();
  const finishDisposal = createDeferred();
  const dispose = source.dispose.bind(source);
  source.dispose = async () => { disposing.resolve(); await finishDisposal.promise; await dispose(); };
  const switching = source.options.onReplaceWorkspace('/two');
  await disposing.promise;
  assert.equal(f.instances[1]!.state.shown, true);
  finishDisposal.resolve();
  await switching;
  await f.application.closeAll();
});

test('closing the source during preparation cancels and disposes its hidden replacement', async () => {
  const f = fixture();
  await f.application.open('/one');
  const gate = createDeferred();
  f.gateNextStart(gate.promise);
  const switching = f.instances[0]!.options.onReplaceWorkspace('/two');
  const rejected = assert.rejects(switching, /canceled/u);
  f.instances[0]!.window.close();
  await f.application.closeAll();
  gate.resolve();
  await rejected;
  assert.equal(f.instances[1]!.state.shown, false);
  assert.equal(f.liveScopes.size, 0);
  assert.equal(f.application.isTransitioning, false);
});

test('shutdown during preparation cannot reveal a late replacement', async () => {
  const f = fixture();
  await f.application.open('/one');
  const gate = createDeferred();
  f.gateNextStart(gate.promise);
  const switching = f.instances[0]!.options.onReplaceWorkspace('/two');
  const rejected = assert.rejects(switching, /canceled/u);
  await f.application.closeAll();
  gate.resolve();
  await rejected;
  assert.equal(f.instances[1]!.state.shown, false);
  assert.equal(f.liveScopes.size, 0);
});

test('replacement uses the latest source geometry after hidden preparation', async () => {
  const f = fixture();
  await f.application.open('/one');
  const gate = createDeferred();
  f.gateNextStart(gate.promise);
  const source = f.instances[0]!;
  const switching = source.options.onReplaceWorkspace('/two');
  const bounds = { x: 300, y: 200, width: 1600, height: 1000 };
  source.window.getNormalBounds = () => bounds;
  source.window.isMaximized = () => true;
  gate.resolve();
  await switching;
  assert.deepEqual(f.instances[1]!.options.windowState, { bounds, maximized: true, fullscreen: false });
  await f.application.closeAll();
});

test('a replacement lost during source close restores the original workspace', async () => {
  const f = fixture();
  await f.application.open('/one');
  const source = f.instances[0]!;
  const close = source.window.close.bind(source.window);
  source.window.close = () => {
    f.instances[1]!.state.destroyed = true;
    close();
  };
  await assert.rejects(source.options.onReplaceWorkspace('/two'), /canceled/u);
  assert.equal(f.instances[1]!.state.shown, false);
  assert.equal(f.instances[1]!.state.disposed, 1);
  assert.equal(f.instances[2]!.options.workspaceRoot, '/one');
  assert.equal(f.instances[2]!.state.shown, true);
  assert.equal(f.application.lastWorkspaceRoot, '/one');
  await f.application.closeAll();
});
