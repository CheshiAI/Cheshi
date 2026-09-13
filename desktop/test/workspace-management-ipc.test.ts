import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rename, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import { readWorkspaceRegistry } from '../../config/workspace-storage.mts';
import { GitHubRepositories } from '../lib/github-repositories.mts';
import { registerWorkspaceManagementIpcHandlers } from '../lib/workspace-management-ipc.mts';

type Handler = Parameters<IpcMain['handle']>[1];

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function eventFor(authorized: boolean, mainFrame = true): IpcMainInvokeEvent {
  const frame = {};
  return {
    sender: { id: authorized ? 1 : 2, mainFrame: frame, isDestroyed: () => false },
    senderFrame: mainFrame ? frame : {},
  } as unknown as IpcMainInvokeEvent;
}

async function fixture(withManager = false, autoReady = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cheshi-workspace-ipc-'));
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const handlers = new Map<string, Handler>();
  const state = {
    githubCalls: [] as string[][],
    githubError: null as Error | null,
    loginCalls: [] as string[],
    codexCalls: [] as string[],
    dialogCalls: 0,
    confirmations: [] as MessageBoxOptions[],
    confirmationResponse: 0,
    trashed: [] as string[],
    deletionLocks: [] as string[],
    ownerCalls: 0,
    appPathCalls: 0,
    senderChecks: 0,
    launches: [] as string[],
    launchCwds: [] as string[],
    launchError: null as Error | null,
    launchGate: null as ReturnType<typeof createDeferred> | null,
    launchStarted: null as ReturnType<typeof createDeferred> | null,
    destroyed: false,
    canceled: true,
    filePaths: [] as string[],
    dialogOwners: [] as BrowserWindow[],
    managerCreated: 0,
    managerShows: 0,
    managerDestroyed: false,
    ownerMissing: false,
    replacements: [] as string[],
    replaceError: null as Error | null,
    replaceGate: null as ReturnType<typeof createDeferred> | null,
  };
  const owner = { isDestroyed: () => state.destroyed } as unknown as BrowserWindow;
  const managerEvents = new EventEmitter();
  const managerFrame = {};
  const managerSender = { id: 3, mainFrame: managerFrame, isDestroyed: () => state.managerDestroyed, setWindowOpenHandler() {}, on() {} };
  const managerWindow = {
    webContents: managerSender,
    once: managerEvents.once.bind(managerEvents), off: managerEvents.off.bind(managerEvents),
    loadFile: async () => {
      if (autoReady) {
        managerEvents.emit('ready-to-show');
        await handlers.get('cheshi:workspace-management:content-ready')!({ sender: managerSender, senderFrame: managerFrame } as unknown as IpcMainInvokeEvent);
      }
    },
    isDestroyed: () => state.managerDestroyed,
    isMinimized: () => false,
    focus() {},
    show() { state.managerShows += 1; },
    close() { state.managerDestroyed = true; managerEvents.emit('closed'); },
    destroy() { state.managerDestroyed = true; managerEvents.emit('closed'); },
  } as unknown as BrowserWindow;
  const registration = registerWorkspaceManagementIpcHandlers({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    app: {
      isPackaged: false,
      getAppPath: () => { state.appPathCalls += 1; return '/application/Cheshi'; },
    },
    dialog: {
      showMessageBox: async (_owner, options?: MessageBoxOptions) => {
        assert.ok(options);
        state.confirmations.push(options);
        return { response: state.confirmationResponse, checkboxChecked: false };
      },
      showOpenDialog: async (dialogOwner) => {
        state.dialogCalls += 1;
        state.dialogOwners.push(dialogOwner as BrowserWindow);
        return { canceled: state.canceled, filePaths: state.filePaths };
      },
    },
    trashItem: async (target) => { state.trashed.push(target); await rename(target, path.join(root, 'trashed-project')); },
    withWorkspaceDeletion: async (target, operation) => { state.deletionLocks.push(target); return operation(); },
    assertWorkspaceAvailable: () => {},
    getWindow: () => { state.ownerCalls += 1; return state.ownerMissing ? null : owner; },
    assertSender: (event, feature) => {
      state.senderChecks += 1;
      assert.equal(feature, 'Workspace management');
      if (event.sender.id !== 1) throw new Error('Untrusted sender');
    },
    dataRoot,
    createCodexLogin: () => {
      state.codexCalls.push('create');
      return {
        getStatus: async () => { state.codexCalls.push('status'); return { state: 'signed_out', error: null }; },
        startLogin: async () => { state.codexCalls.push('start'); return { state: 'signing_in', error: null }; },
        cancelLogin: async () => { state.codexCalls.push('cancel'); return { state: 'signed_out', error: null }; },
        dispose: async () => { state.codexCalls.push('dispose'); },
      };
    },
    githubLogin: {
      start: () => { state.loginCalls.push('start'); return { state: 'starting', userCode: null, error: null }; },
      status: () => { state.loginCalls.push('status'); return { state: 'waiting', userCode: 'TEST-CODE', error: null }; },
      cancel: () => { state.loginCalls.push('cancel'); },
      openBrowser: async () => { state.loginCalls.push('browser'); },
      dispose: () => { state.loginCalls.push('dispose'); },
    },
    github: new GitHubRepositories(async (args) => {
      state.githubCalls.push(args);
      if (state.githubError) throw state.githubError;
      return JSON.stringify(args.at(-1) === 'user' ? { login: 'example' } : []);
    }),
    ...(withManager ? {
      manager: {
        workspaceRoot: workspace,
        createWindow: () => { state.managerCreated += 1; state.managerDestroyed = false; return managerWindow; },
      },
    } : {}),
    onReplaceWorkspace: async (workspaceRoot) => {
      state.replacements.push(workspaceRoot);
      await state.replaceGate?.promise;
      if (state.replaceError) throw state.replaceError;
    },
    onOpenWorkspace: async (workspaceRoot) => {
      assert.ok(readWorkspaceRegistry(dataRoot).workspaces.some((entry) => entry.rootPath === workspaceRoot));
      state.launches.push(workspaceRoot);
      state.launchCwds.push(process.cwd());
      state.launchStarted?.resolve();
      await state.launchGate?.promise;
      if (state.launchError) throw state.launchError;
    },
  });
  const invoke = async (name: string, value?: unknown, event = eventFor(true)): Promise<unknown> => {
    const handler = handlers.get(`cheshi:workspace-management:${name}`);
    assert.ok(handler, `Missing handler: ${name}`);
    return handler(event, value);
  };
  const managerEvent = { sender: managerSender, senderFrame: managerFrame } as unknown as IpcMainInvokeEvent;
  return { root, dataRoot, workspace, handlers, state, invoke, owner, managerWindow, managerEvent, managerEvents, registration };
}

async function rejects(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  let rejected = false;
  try { await operation; } catch (error) {
    rejected = true;
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
  }
  assert.equal(rejected, true, 'Expected operation to reject');
}

test('every workspace handler rejects untrusted senders and subframes before touching resources', async () => {
  const f = await fixture();
  try {
    await mkdir(f.dataRoot);
    await writeFile(path.join(f.dataRoot, 'workspaces.json'), 'invalid registry');
    const names = ['content-ready', 'list', 'get-tool-status', 'get-codex-login', 'start-codex-login', 'cancel-codex-login', 'add-folder', 'create-project', 'delete-workspace', 'clone', 'list-worktrees', 'create-worktree', 'choose-directory', 'open', 'open-manager', 'open-current', 'list-github-repositories',
      'start-github-login', 'get-github-login', 'cancel-github-login', 'open-github-login-browser'];
    assert.equal(f.handlers.size, names.length);
    for (const name of names) {
      await rejects(f.invoke(name, f.workspace, eventFor(false)), /Untrusted sender/u);
      await rejects(f.invoke(name, f.workspace, eventFor(true, false)), /main window frame/u);
    }
    assert.equal(f.state.senderChecks, names.length * 2);
    assert.deepEqual(f.state.githubCalls, []);
    assert.deepEqual(f.state.loginCalls, []);
    assert.deepEqual(f.state.codexCalls, []);
    assert.equal(f.state.ownerCalls, 0);
    assert.equal(f.state.dialogCalls, 0);
    assert.deepEqual(f.state.confirmations, []);
    assert.deepEqual(f.state.trashed, []);
    assert.equal(f.state.appPathCalls, 0);
    assert.deepEqual(f.state.launches, []);
    assert.equal(existsSync(path.join(f.dataRoot, 'workspaces')), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('manager creates a Git project, registers it, and opens it through the existing workspace flow', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    const project = path.join(f.root, 'new project');
    await f.invoke('create-project', { parentPath: f.root, directoryName: 'new project' }, f.managerEvent);
    assert.equal(existsSync(path.join(project, '.git', 'HEAD')), true);
    const entries = readWorkspaceRegistry(f.dataRoot).workspaces;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.rootPath, await realpath(project));
    assert.deepEqual(f.state.launches, []);
    assert.equal(f.state.managerDestroyed, false);
    await f.invoke('open', project, f.managerEvent);
    assert.deepEqual(f.state.launches, [await realpath(project)]);
    assert.equal(f.state.managerDestroyed, true);
  } finally { await f.registration.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('manager main frame can manage workspaces with its own chooser while other senders remain denied', async () => {
  const f = await fixture(true);
  try {
    await rejects(f.invoke('list', undefined, f.managerEvent), /Untrusted sender/u);
    await f.invoke('open-manager');
    assert.equal(f.state.managerCreated, 1);
    const senderChecks = f.state.senderChecks;
    assert.deepEqual(await f.invoke('list', undefined, f.managerEvent), { workspaces: [] });
    assert.equal(await f.invoke('choose-directory', undefined, f.managerEvent), null);
    assert.equal(f.state.senderChecks, senderChecks);
    assert.equal(f.state.dialogOwners[0], f.managerWindow);
    assert.equal(f.state.ownerCalls, 0);
    await rejects(f.invoke('list', undefined, eventFor(false)), /Untrusted sender/u);
    const subframe = { ...f.managerEvent, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    await rejects(f.invoke('choose-directory', undefined, subframe), /main window frame/u);
    assert.equal(f.state.dialogCalls, 1);
    await f.invoke('choose-directory');
    assert.equal(f.state.dialogOwners[1], f.owner);
    assert.equal(f.state.ownerCalls, 1);
    f.state.managerDestroyed = true;
    await rejects(f.invoke('list', undefined, f.managerEvent), /Untrusted sender/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('GitHub login routes stay in the authorized manager and stop when its window closes', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    assert.deepEqual(await f.invoke('start-github-login', undefined, f.managerEvent), { state: 'starting', userCode: null, error: null });
    assert.deepEqual(await f.invoke('get-github-login', undefined, f.managerEvent), { state: 'waiting', userCode: 'TEST-CODE', error: null });
    // Caller-supplied URLs cannot select a different browser destination.
    await f.invoke('open-github-login-browser', 'https://untrusted.example', f.managerEvent);
    await f.invoke('cancel-github-login', undefined, f.managerEvent);
    assert.deepEqual(f.state.loginCalls, ['start', 'status', 'browser', 'cancel']);
    f.managerWindow.close();
    assert.equal(f.state.loginCalls.at(-1), 'cancel');
    f.registration.dispose();
    assert.equal(f.state.loginCalls.at(-1), 'dispose');
  } finally { f.registration.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('folder chooser returns null when canceled and returns only the selected folder', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.invoke('choose-directory'), null);
    assert.equal(f.state.dialogCalls, 1);
    f.state.canceled = false;
    f.state.filePaths = [f.workspace];
    assert.equal(await f.invoke('choose-directory'), f.workspace);
    assert.equal(existsSync(f.dataRoot), false);
    f.state.destroyed = true;
    await rejects(f.invoke('choose-directory'), /no longer available/u);
    assert.equal(f.state.dialogCalls, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('opening validates and registers a workspace before invoking the in-process opener without changing process cwd', async () => {
  const f = await fixture();
  const cwd = process.cwd();
  try {
    await rejects(f.invoke('open', 'relative/path'), /absolute path/u);
    assert.equal(f.state.launches.length, 0);
    assert.equal(existsSync(f.dataRoot), false);
    await f.invoke('open', f.workspace);
    const workspaceRoot = await realpath(f.workspace);
    assert.deepEqual(f.state.launches, [workspaceRoot]);
    assert.deepEqual(f.state.launchCwds, [cwd]);
    assert.equal(process.cwd(), cwd);
    const registry = readWorkspaceRegistry(f.dataRoot);
    assert.equal(registry.workspaces.length, 1);
    assert.equal(registry.workspaces[0]!.rootPath, workspaceRoot);
    assert.equal(existsSync(registry.workspaces[0]!.codeGraphPath), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('launch failure reaches the caller and preserves the registered workspace', async () => {
  const f = await fixture();
  try {
    f.state.launchError = new Error('Launch unavailable');
    await rejects(f.invoke('open', f.workspace), /Launch unavailable/u);
    assert.equal(f.state.launches.length, 1);
    assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
    assert.equal(existsSync(f.workspace), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('manager closes only after workspace opening completes and can be opened again', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    f.state.launchGate = createDeferred();
    f.state.launchStarted = createDeferred();
    const opening = f.invoke('open', f.workspace, f.managerEvent);
    await f.state.launchStarted.promise;
    assert.equal(f.state.managerDestroyed, false);
    f.state.launchGate.resolve();
    await opening;
    assert.equal(f.state.managerDestroyed, true);
    assert.equal(f.state.destroyed, false);
    await f.invoke('open-manager');
    assert.equal(f.state.managerCreated, 2);
    assert.equal(f.state.managerDestroyed, false);
  } finally { f.state.launchGate?.resolve(); await rm(f.root, { recursive: true, force: true }); }
});

test('failed manager opening stays retryable and opening from the main window leaves the manager alone', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    f.state.launchError = new Error('Launch unavailable');
    await rejects(f.invoke('open', f.workspace, f.managerEvent), /Launch unavailable/u);
    assert.equal(f.state.managerDestroyed, false);
    f.state.launchError = null;
    await f.invoke('open', f.workspace);
    assert.equal(f.state.managerDestroyed, false);
    await f.invoke('open', f.workspace, f.managerEvent);
    assert.equal(f.state.managerDestroyed, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('current-window opening targets the original workspace window even when requested by the manager', async () => {
  const f = await fixture(true);
  const target = path.join(f.root, 'other');
  try {
    await mkdir(target);
    await f.invoke('open-manager');
    f.state.replaceError = new Error('Save unsaved files');
    await rejects(f.invoke('open-current', target, f.managerEvent), /Save unsaved files/u);
    assert.equal(f.state.managerDestroyed, false);
    f.state.replaceError = null;
    await f.invoke('open-current', target, f.managerEvent);
    assert.equal(f.state.replacements.length, 2);
    assert.equal(f.state.replacements[0], await realpath(target));
    assert.deepEqual(f.state.launches, []);
    assert.equal(f.state.managerDestroyed, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('current-window opening rejects the same canonical workspace including symbolic link aliases', async () => {
  const f = await fixture(true);
  try {
    const alias = path.join(f.root, 'alias');
    await createSymbolicLink(f.workspace, alias, 'dir');
    for (const target of [f.workspace, alias]) {
      await rejects(f.invoke('open-current', target), /already open/u);
    }
    assert.deepEqual(f.state.replacements, []);
    assert.deepEqual(f.state.launches, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('current-window opening rejects invalid destinations and missing original windows without replacement', async () => {
  const f = await fixture(true);
  try {
    for (const target of ['relative/path', path.join(f.root, 'missing'), null]) {
      await rejects(f.invoke('open-current', target), /absolute path|ENOENT|non-empty text/u);
    }
    f.state.destroyed = true;
    await rejects(f.invoke('open-current', f.workspace), /no longer available/u);
    f.state.destroyed = false;
    f.state.ownerMissing = true;
    await rejects(f.invoke('open-current', f.workspace), /no longer available/u);
    assert.deepEqual(f.state.replacements, []);
    assert.deepEqual(f.state.launches, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
  const unavailable = await fixture();
  try {
    await rejects(unavailable.invoke('open-current', unavailable.workspace), /no longer available/u);
    assert.deepEqual(unavailable.state.replacements, []);
  } finally { await rm(unavailable.root, { recursive: true, force: true }); }
});

test('current-window switching rejects concurrent requests and releases the guard after failure for retry', async () => {
  const f = await fixture(true);
  const target = path.join(f.root, 'other');
  try {
    await mkdir(target);
    const gate = createDeferred();
    f.state.replaceGate = gate;
    f.state.replaceError = new Error('Save unsaved files');
    const first = f.invoke('open-current', target);
    const firstFailure = rejects(first, /Save unsaved files/u);
    await rejects(f.invoke('open-current', target), /already in progress/u);
    gate.resolve();
    await firstFailure;
    assert.equal(f.state.replacements.length, 1);
    f.state.replaceError = null;
    f.state.replaceGate = null;
    await f.invoke('open-current', target);
    assert.equal(f.state.replacements.length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('disposing management closes its window and rejects further manager requests', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    f.registration.dispose();
    f.registration.dispose();
    assert.equal(f.state.managerDestroyed, true);
    await rejects(f.invoke('open-manager'), /closed/u);
    await rejects(f.invoke('list', undefined, f.managerEvent), /closed/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Codex account routes are lazy, isolated and disposed when the manager closes', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    assert.deepEqual(f.state.codexCalls, []);
    assert.deepEqual(await f.invoke('get-codex-login', undefined, f.managerEvent), { state: 'signed_out', error: null });
    assert.deepEqual(await f.invoke('start-codex-login', undefined, f.managerEvent), { state: 'signing_in', error: null });
    assert.deepEqual(await f.invoke('cancel-codex-login', undefined, f.managerEvent), { state: 'signed_out', error: null });
    assert.deepEqual(f.state.codexCalls, ['create', 'status', 'start', 'cancel']);
    assert.equal(existsSync(f.dataRoot), false);
    assert.deepEqual(f.state.launches, []);
    f.managerWindow.close();
    assert.deepEqual(f.state.codexCalls, ['create', 'status', 'start', 'cancel', 'dispose']);
    await f.registration.dispose();
    assert.equal(f.state.codexCalls.filter((call) => call === 'dispose').length, 1);
  } finally { await f.registration.dispose(); await rm(f.root, { recursive: true, force: true }); }
});


test('repository listing returns an authentication state for signed-out requests and preserves other failures', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    for (const message of ['gh auth login', 'HTTP 401: Bad credentials']) {
      f.state.githubError = new Error(message);
      assert.deepEqual(await f.invoke('list-github-repositories', 1, f.managerEvent), { status: 'authentication-required' });
    }
    f.state.githubError = new Error('HTTP 403: Forbidden');
    await rejects(f.invoke('list-github-repositories', 1, f.managerEvent), /GitHub denied/u);
    f.state.githubError = new Error('connection refused');
    await rejects(f.invoke('list-github-repositories', 1, f.managerEvent), /connection/u);
    f.state.githubError = null;
    assert.deepEqual(await f.invoke('list-github-repositories', 1, f.managerEvent), {
      status: 'ready', page: { repositories: [], nextPage: null, login: 'example' },
    });
    assert.deepEqual(f.state.loginCalls, []);
  } finally { f.registration.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test('repository listing uses the authenticated manager route without registering or opening a workspace', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    assert.deepEqual(await f.invoke('list-github-repositories', 2, f.managerEvent), {
      status: 'ready', page: { repositories: [], nextPage: null, login: 'example' },
    });
    assert.equal(f.state.githubCalls.length, 2);
    assert.match(f.state.githubCalls[1]!.at(-1)!, /page=2$/u);
    assert.equal(existsSync(f.dataRoot), false);
    assert.deepEqual(f.state.launches, []);
    await rejects(f.invoke('list-github-repositories', '2', f.managerEvent), /positive integer/u);
    assert.equal(f.state.githubCalls.length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('deletion confirms the registered folder with cancel as default before moving it to Trash', async () => {
  const f = await fixture(true);
  try {
    await f.invoke('open-manager');
    await f.invoke('add-folder', f.workspace, f.managerEvent);
    const entry = readWorkspaceRegistry(f.dataRoot).workspaces[0]!;
    assert.equal(await f.invoke('delete-workspace', entry.id, f.managerEvent), false);
    assert.equal(existsSync(f.workspace), true);
    assert.deepEqual(f.state.trashed, []);
    const confirmation = f.state.confirmations[0]!;
    assert.equal(confirmation.defaultId, 0);
    assert.equal(confirmation.cancelId, 0);
    assert.deepEqual(confirmation.buttons, ['Cancel', 'Move to Trash']);
    assert.ok(confirmation.detail?.includes(entry.rootPath));
    assert.ok(confirmation.detail?.includes('uncommitted files'));
    assert.ok(confirmation.detail?.includes('CodeGraph index'));
    assert.ok(confirmation.detail?.includes('Chat history will be kept'));
    f.state.confirmationResponse = 1;
    assert.equal(await f.invoke('delete-workspace', entry.id, f.managerEvent), true);
    assert.deepEqual(f.state.trashed, [entry.rootPath]);
    assert.deepEqual(f.state.deletionLocks, [entry.rootPath, entry.rootPath]);
    assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
    assert.equal(existsSync(f.workspace), false);
  } finally { f.registration.dispose(); await rm(f.root, { recursive: true, force: true }); }
});


test('content-ready accepts only the owning manager main frame and waits for native readiness', async () => {
  const f = await fixture(true, false);
  try {
    const opening = f.invoke('open-manager');
    await rejects(f.invoke('content-ready'), /manager window/u);
    await rejects(f.invoke('content-ready', undefined, { ...f.managerEvent, senderFrame: {} } as IpcMainInvokeEvent), /main window frame/u);
    assert.equal(f.state.managerShows, 0);
    await f.invoke('content-ready', undefined, f.managerEvent);
    assert.equal(f.state.managerShows, 0);
    f.managerEvents.emit('ready-to-show');
    await opening;
    assert.equal(f.state.managerShows, 1);
    await f.invoke('content-ready', undefined, f.managerEvent);
    assert.equal(f.state.managerShows, 1);
  } finally { await f.registration.dispose(); await rm(f.root, { recursive: true, force: true }); }
});
