import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { createAppUpdateResume } from '../lib/app-update-resume.mts';
import type { WorkspaceRuntimeOptions } from '../lib/workspace-application.mts';
import { APP_UPDATE_CHANNEL } from '../shared/app-update.ts';

type Resume = ReturnType<typeof createAppUpdateResume>;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-update-resume-'));
  directories.push(directory);
  return { directory, manager: createAppUpdateResume(directory) };
}
async function expectFailure(operation: Promise<unknown>, message: string) {
  let rejection: unknown;
  try { await operation; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(success => { resolve = success; });
  return { promise, resolve };
}
function register(manager: Resume, root: string, managementOnly = false, autoCommit = true) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const requests: string[] = [];
  const cancellations: string[] = [];
  const committed = createDeferred<string>();
  let destroyed = false;
  const options = {
    workspaceRoot: root, managementOnly, initial: true,
    scope: { ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } },
  };
  const registration = manager.register(options as unknown as WorkspaceRuntimeOptions);
  const window = {
    isDestroyed: () => destroyed,
    getNormalBounds: () => ({ x: 10, y: 20, width: 900, height: 700 }),
    isMaximized: () => false, isFullScreen: () => false,
    webContents: { send: (channel: string, requestId: string) => {
      if (channel.endsWith(':prepare')) requests.push(requestId);
      else if (channel.endsWith(':committed')) {
        committed.resolve(requestId);
        if (autoCommit) handlers.get(`${APP_UPDATE_CHANNEL}:ack`)!(undefined, requestId, null);
      }
      else cancellations.push(channel);
    } },
  };
  registration.attach(window as unknown as BrowserWindow);
  const invoke = async (name: string, ...args: unknown[]) => handlers.get(`${APP_UPDATE_CHANNEL}:${name}`)!(undefined, ...args);
  return {
    requests, cancellations, invoke, committed: committed.promise,
    complete: async (snapshot: unknown = { draft: 'unsaved work' }) => {
      await invoke('save', snapshot);
      await invoke('ack', requests.at(-1), null);
    },
    close: () => { destroyed = true; registration.dispose(); },
  };
}

describe('update workspace recovery', () => {
  it('persists active recovery data before releasing renderer close guards and awaits their acknowledgement', async () => {
    const { directory, manager } = await fixture();
    const window = register(manager, '/work/project', false, false);
    const preparation = manager.prepare();
    await window.complete({ draft: 'durable before close' });
    await preparation;
    let activated = false;
    const activation = manager.activate().then(() => { activated = true; });
    const requestId = await window.committed;
    const manifest = JSON.parse(await readFile(path.join(directory, 'update-resume.json'), 'utf8'));
    expect(manifest.windows[0].snapshot.draft).toBe('durable before close');
    expect(activated).toBe(false);
    await window.invoke('ack', requestId, null);
    await activation;
    expect(activated).toBe(true);
  });

  it('keeps prepared snapshots inactive until activation and restores each window once', async () => {
    const { directory, manager } = await fixture();
    const first = register(manager, '/work/project');
    const second = register(manager, '/work/project');
    const preparation = manager.prepare();
    await first.complete({ draft: 'first' });
    await second.complete({ draft: 'second' });
    await preparation;
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
    await manager.activate();
    const restarted = createAppUpdateResume(directory);
    const windows = await restarted.load();
    expect(windows).toHaveLength(2);
    expect(windows[0]?.windowState?.bounds.width).toBe(900);
    const restoredFirst = register(restarted, '/work/project');
    const restoredSecond = register(restarted, '/work/project');
    expect(await restoredFirst.invoke('resume')).toEqual({ draft: 'first' });
    expect(await restoredSecond.invoke('resume')).toEqual({ draft: 'second' });
    await Promise.all([restoredFirst.invoke('clear'), restoredSecond.invoke('clear')]);
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
  });

  it('cancel removes inactive checkpoints and active snapshots while all windows remain open', async () => {
    const { directory, manager } = await fixture();
    const window = register(manager, '/work/project');
    let preparation = manager.prepare();
    await window.complete();
    await preparation;
    await manager.cancel();
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
    await expectFailure(readFile(path.join(directory, 'update-resume.pending.json')), 'ENOENT');
    preparation = manager.prepare();
    await window.complete();
    await preparation;
    await manager.activate();
    await manager.cancel();
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
    expect(window.cancellations).toHaveLength(2);
  });

  it('retains the durable recovery manifest if shutdown already closed a window', async () => {
    const { directory, manager } = await fixture();
    const first = register(manager, '/work/first');
    const second = register(manager, '/work/second');
    const preparation = manager.prepare();
    await Promise.all([first.complete(), second.complete()]);
    await preparation;
    await manager.activate();
    first.close();
    await manager.cancel();
    expect(await createAppUpdateResume(directory).load()).toHaveLength(2);
  });

  it('cleans all outstanding acknowledgements after one failure and permits an immediate retry', async () => {
    const { manager } = await fixture();
    const first = register(manager, '/work/first');
    const second = register(manager, '/work/second');
    const failed = expectFailure(manager.prepare(), 'renderer failed');
    await first.invoke('ack', first.requests[0], 'renderer failed');
    await failed;
    await expectFailure(second.invoke('ack', second.requests[0], null), 'acknowledgement');
    const retry = manager.prepare();
    await Promise.all([first.complete(), second.complete()]);
    await retry;
    await manager.activate();
  });

  it('requires saved data before accepting an acknowledgement and rejects stale request IDs', async () => {
    const { manager } = await fixture();
    const window = register(manager, '/work/project');
    const failed = expectFailure(manager.prepare(), 'not saved');
    await expectFailure(window.invoke('ack', 'stale-request', null), 'acknowledgement');
    await window.invoke('ack', window.requests[0], null);
    await failed;
    await expectFailure(window.invoke('save', {}), 'pending');
  });

  it('rejects window changes before activation and does not publish an incomplete checkpoint', async () => {
    const { directory, manager } = await fixture();
    const window = register(manager, '/work/project');
    const preparation = manager.prepare();
    await window.complete();
    await preparation;
    register(manager, '/work/new');
    await expectFailure(manager.activate(), 'windows changed');
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
  });

  it('cancels pending preparation without leaving a startup recovery manifest', async () => {
    const { directory, manager } = await fixture();
    register(manager, '/work/project');
    const failed = expectFailure(manager.prepare(), 'cancelled');
    await manager.cancel();
    await failed;
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
    await expectFailure(manager.activate(), 'completed');
  });

  it('records management windows without requesting editor snapshots', async () => {
    const { directory, manager } = await fixture();
    const window = register(manager, '', true);
    await manager.prepare();
    await manager.activate();
    expect(window.requests).toEqual([]);
    const restarted = createAppUpdateResume(directory);
    expect((await restarted.load())[0]?.managementOnly).toBe(true);
    const restoredManager = register(restarted, '', true);
    // A queued no-op clear also awaits the automatic consumption started by attach.
    await restoredManager.invoke('clear');
    expect(await createAppUpdateResume(directory).load()).toEqual([]);
  });

  it('rejects malformed persisted data instead of opening arbitrary workspace roots', async () => {
    const { directory } = await fixture();
    const valid = { id: 'first', root: '/work/project', managementOnly: false, snapshot: {} };
    for (const windows of [[{ ...valid, managementOnly: 'false' }], [{ ...valid, root: '/' }], [{ ...valid, root: 'relative' }], [valid, valid], [{ ...valid, snapshot: null }], [{ ...valid, windowState: { bounds: { x: 0, y: 0, width: -1, height: 10 }, maximized: false, fullscreen: false } }]]) {
      await writeFile(path.join(directory, 'update-resume.json'), JSON.stringify({ schema: 1, windows }));
      await expectFailure(createAppUpdateResume(directory).load(), '');
    }
  });
});
