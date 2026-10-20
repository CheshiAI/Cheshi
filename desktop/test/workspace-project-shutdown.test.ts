import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createWorkspaceProjects } from '../lib/workspace-project-runtime.mts';
import { WorkspaceClosedError, unwrapWorkspaceIpcResponse } from '../shared/workspace-ipc-lifecycle.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function failure(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return String(error); }
  throw new Error('Expected the operation to fail.');
}

async function fixture(run: (h: {
  runtime: ReturnType<typeof createWorkspaceProjects>;
  invoke: (name: string, ...args: unknown[]) => Promise<unknown>;
  invokeRaw: (name: string, ...args: unknown[]) => Promise<unknown>;
  checks: () => number;
  closeWindow: () => void;
  choose: ReturnType<typeof createDeferred<string | null>>;
  linked: string;
  assertSender: (event: IpcMainInvokeEvent) => void;
}) => Promise<void>) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cheshi-project-shutdown-')));
  const root = path.join(base, 'root'), linked = path.join(base, 'linked');
  await Promise.all([mkdir(root), mkdir(linked)]);
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const ipc: Pick<IpcMain, 'handle'> = { handle: (name, handler) => { handlers.set(name, handler); } };
  let open = true, checks = 0;
  const assertSender = (_event: IpcMainInvokeEvent) => {
    checks++;
    if (!open) throw new Error('Cheshi IPC sender is not the active Cheshi window.');
  };
  const choose = createDeferred<string | null>();
  const runtime = createWorkspaceProjects({
    ipc, root, dataRoot: path.join(base, 'data'), clipboard: { writeText() {} },
    shell: { trashItem: async () => {}, openExternal: async () => {} },
    languageOptions: { settingsPath: path.join(base, 'languages.json'), clientInfo: { name: 'test', version: '1' } },
    assertSender, assertIdle() {}, chooseDirectory: () => choose.promise, emit() {},
  });
  const invokeRaw = async (name: string, ...args: unknown[]) => {
    const handler = handlers.get(`cheshi:${name}`);
    if (!handler) throw new Error('Missing handler.');
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  try {
    await run({ runtime, choose, linked, assertSender, checks: () => checks, closeWindow: () => { open = false; },
      invokeRaw,
      invoke: async (name, ...args) => unwrapWorkspaceIpcResponse(await invokeRaw(name, ...args)),
    });
  } finally { choose.resolve(null); await runtime.dispose(); await rm(base, { recursive: true, force: true }); }
}

test('shutdown during realpath cancels dispatch before a second sender check or linked service creation', async () => {
  await fixture(async h => {
    const linked = (await h.runtime.store.add(h.linked))[1]!;
    h.runtime.ipc.handle('cheshi:get-git-snapshot', event => {
      h.assertSender(event);
      return { available: true };
    });
    const primary = failure(h.invoke('workspace-projects:invoke', 'primary', 'cheshi:get-git-snapshot', []));
    const secondary = failure(h.invoke('workspace-projects:invoke', linked.id, 'cheshi:get-git-snapshot', []));
    expect(h.checks()).toBe(2);
    h.runtime.stopAccepting();
    h.closeWindow();
    await h.runtime.dispose();
    expect(await primary).toContain('workspace has closed');
    expect(await secondary).toContain('workspace has closed');
    expect(h.checks()).toBe(2);
  });
});

test('closing during path resolution resolves the native handler but rejects the feature request as cancellation', async () => {
  await fixture(async h => {
    let dispatched = false;
    h.runtime.ipc.handle('cheshi:get-git-snapshot', () => { dispatched = true; return { available: true }; });
    const request = h.invokeRaw('workspace-projects:invoke', 'primary', 'cheshi:get-git-snapshot', []);
    h.runtime.stopAccepting();
    h.closeWindow();
    const response = await request;
    expect(dispatched).toBe(false);
    expect(() => unwrapWorkspaceIpcResponse(structuredClone(response))).toThrow(WorkspaceClosedError);
    await h.runtime.dispose();
  });
});

test('ordinary operation failures are not converted to lifecycle cancellation', async () => {
  await fixture(async h => {
    h.runtime.ipc.handle('cheshi:get-git-snapshot', () => { throw new Error('The workspace has closed.'); });
    expect(await failure(h.invokeRaw('workspace-projects:invoke', 'primary', 'cheshi:get-git-snapshot', [])))
      .toBe('Error: The workspace has closed.');
  });
});

test('dispose drains dispatched work, rejects new requests, and is idempotent', async () => {
  await fixture(async h => {
    const started = createDeferred<void>(), finish = createDeferred<string>();
    h.runtime.ipc.handle('cheshi:get-git-snapshot', event => {
      h.assertSender(event); started.resolve(); return finish.promise;
    });
    const request = h.invoke('workspace-projects:invoke', 'primary', 'cheshi:get-git-snapshot', []);
    await started.promise;
    const disposal = h.runtime.dispose();
    expect(h.runtime.dispose()).toBe(disposal);
    let disposed = false;
    void disposal.then(() => { disposed = true; });
    expect(await failure(h.invoke('get-git-snapshot'))).toContain('workspace has closed');
    expect(await failure(h.invoke('workspace-projects:list'))).toContain('workspace has closed');
    expect(disposed).toBe(false);
    finish.resolve('finished');
    expect(await request).toBe('finished');
    await disposal;
    h.closeWindow();
    expect(disposed).toBe(true);
  });
});

test('a late directory selection cannot reconnect a project after shutdown', async () => {
  await fixture(async h => {
    const adding = failure(h.invoke('workspace-projects:add'));
    await h.runtime.dispose();
    h.closeWindow();
    h.choose.resolve(h.linked);
    expect(await adding).toContain('workspace has closed');
    expect(h.runtime.store.list()).toHaveLength(1);
  });
});

test('an open native executable picker does not hold shutdown waiting for user input', async () => {
  await fixture(async h => {
    const selection = createDeferred<null>();
    h.runtime.ipc.handle('cheshi:select-language-server-executable', () => selection.promise);
    const picking = h.invoke('select-language-server-executable', 'typescript');
    await h.runtime.dispose();
    h.closeWindow();
    selection.resolve(null);
    expect(await picking).toBeNull();
  });
});

test('sender validation still rejects unauthorized requests while the service is open', async () => {
  await fixture(async h => {
    h.closeWindow();
    expect(await failure(h.invoke('workspace-projects:list'))).toContain('not the active Cheshi window');
    expect(h.checks()).toBe(1);
  });
});
