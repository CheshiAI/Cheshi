import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorSessionStore } from '../lib/editor-session.mts';
import { parseEditorSession } from '../shared/editor-session';
import { captureEditorSession, restoreEditorSession } from '../frontend/src/features/editor/workspaceEditorSession';
import { readWorkspaceFile } from '../lib/workspace-file-reads.mts';
import { loadForgeConfiguration } from './forge-test-helpers';
import { createEditorSessionIpc } from '../lib/editor-session-ipc.mts';
import { createEditorSessionApi } from '../lib/editor-session-preload.cts';
import type { IpcMainInvokeEvent } from 'electron';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-editor-session-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('recreated stores restore ordered files and selection, with current disk content and workspace isolation', async () => {
  await fixture(async directory => {
    const a = join(directory, 'workspace-a');
    const b = join(directory, 'workspace-b');
    const store = new EditorSessionStore(a);
    await writeFile(join(directory, 'first.ts'), 'first\r\n');
    await writeFile(join(directory, 'second.ts'), 'second');
    await store.save({ version: 1, paths: ['second.ts', 'first.ts'], selectedPath: 'first.ts' });
    await writeFile(join(directory, 'first.ts'), 'changed');
    const saved = await new EditorSessionStore(a).read();
    expect(saved).not.toBeNull();
    let generation = 0;
    const restored = await restoreEditorSession(saved!, path => readWorkspaceFile(directory, path), () => ++generation);
    expect(restored.tabs.map(tab => tab.path)).toEqual(['second.ts', 'first.ts']);
    expect(restored.selectedPath).toBe('first.ts');
    expect(restored.tabs[1]?.draftContent).toBe('changed');
    expect(await new EditorSessionStore(b).read()).toBeNull();
    expect(JSON.parse(await readFile(join(a, 'editor-session.json'), 'utf8'))).toEqual(saved);
    expect(Object.keys(captureEditorSession(restored.tabs, restored.selectedPath))).toEqual(['version', 'paths', 'selectedPath']);
  });
});

test('queued writes and flush keep the latest closed-tab state across restart', async () => {
  await fixture(async directory => {
    const store = new EditorSessionStore(directory);
    const writes = [
      store.save({ version: 1, paths: ['a.ts', 'b.ts'], selectedPath: 'b.ts' }),
      store.save({ version: 1, paths: ['a.ts'], selectedPath: 'a.ts' }),
      store.save({ version: 1, paths: [], selectedPath: null }),
    ];
    await store.flush();
    await Promise.all(writes);
    expect(await new EditorSessionStore(directory).read()).toEqual({ version: 1, paths: [], selectedPath: null });
    expect(await readdir(directory)).toEqual(['editor-session.json']);
  });
});

test('missing or unreadable files do not block restoration, including a missing selected file', async () => {
  await fixture(async directory => {
    await writeFile(join(directory, 'available.ts'), 'ok');
    const saved = { version: 1 as const, paths: ['missing.ts', 'unreadable.ts', 'available.ts'], selectedPath: 'missing.ts' };
    const restored = await restoreEditorSession(saved, path => {
      if (path === 'unreadable.ts') return Promise.reject(new Error('EACCES'));
      return readWorkspaceFile(directory, path);
    }, () => 1);
    expect(restored.tabs.map(tab => tab.path)).toEqual(['available.ts']);
    expect(restored.selectedPath).toBe('available.ts');
    expect(await restoreEditorSession({ ...saved, paths: ['missing.ts'] }, path => readWorkspaceFile(directory, path), () => 1))
      .toEqual({ tabs: [], selectedPath: null });
  });
});

test('malformed sessions and invalid paths are rejected without blocking startup', async () => {
  for (const paths of [['../secret'], ['/absolute'], ['a.ts', 'a.ts'], ['a\\b'], ['a\0b']]) {
    expect(() => parseEditorSession({ version: 1, paths, selectedPath: null })).toThrow();
  }
  expect(() => parseEditorSession({ version: 1, paths: ['a.ts'], selectedPath: 'b.ts' })).toThrow();
  await fixture(async directory => {
    await writeFile(join(directory, 'editor-session.json'), '{');
    expect(await new EditorSessionStore(directory).read()).toBeNull();
    await writeFile(join(directory, 'editor-session.json'), JSON.stringify({ version: 99, paths: [] }));
    expect(await new EditorSessionStore(directory).read()).toBeNull();
  });
});

test('packaging includes the editor session runtime and its shared contract', async () => {
  const config = await loadForgeConfiguration();
  const ignore = config.packagerConfig.ignore;
  if (typeof ignore !== 'function') throw new Error('Missing packaging filter');
  for (const path of ['lib/editor-session.mts', 'lib/editor-session-ipc.mts', 'lib/workspace-session-stores.mts', 'shared/editor-session.ts']) {
    expect(ignore(`/desktop/${path}`)).toBe(false);
  }
});

test('preload and IPC save only validated metadata for the authorized workspace sender', async () => {
  await fixture(async directory => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    let authorized = true;
    const store = createEditorSessionIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, directory,
      () => { if (!authorized) throw new Error('Unauthorized sender'); });
    const api = createEditorSessionApi({ async invoke(channel, ...args: unknown[]) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error('Missing handler');
      return handler({} as IpcMainInvokeEvent, ...args);
    } });
    const session = { version: 1 as const, paths: ['a.ts'], selectedPath: 'a.ts' };
    expect(await api.read()).toBeNull();
    await api.save(session);
    expect(await api.read()).toEqual(session);
    authorized = false;
    let rejected: unknown;
    try { await api.save({ version: 1, paths: [], selectedPath: null }); } catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(Error);
    expect(await store.read()).toEqual(session);
  });
});
