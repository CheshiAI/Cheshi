import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWorkspaceFiles } from '../lib/workspace-file-search.mts';
import { createWorkspaceFileSearchApi } from '../lib/workspace-file-search-preload.cts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';
import { workspaceFileSearchQuery, workspaceFileSearchResult } from '../shared/workspace-file-search';
import { loadForgeConfiguration } from './forge-test-helpers';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

async function fixture(run: (root: string, file: (path: string, content?: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-file-search-'));
  const file = async (path: string, content = 'test') => {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  try { await run(root, file); } finally { await rm(root, { recursive: true, force: true }); }
}

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); }

test('searches tracked and untracked paths, ranks names and excludes ignored or deleted files', async () => {
  await fixture(async (root, file) => {
    git(root, 'init', '--quiet');
    await file('.gitignore', 'ignored/\n');
    await file('tracked/Note.txt'); await file('deleted-note.txt');
    git(root, 'add', '.');
    await rm(join(root, 'deleted-note.txt'));
    await file('new/note.txt'); await file('note.txt'); await file('NOTE-other.txt');
    await file('note-directory/other.txt'); await file('ignored/note.txt'); await file('.hidden-note');
    const result = await searchWorkspaceFiles(root, 'NOTE.TXT');
    expect(result.files.map(entry => entry.path)).toEqual(['new/note.txt', 'note.txt', 'tracked/Note.txt']);
    expect(result.truncated).toBe(false);
    const partial = await searchWorkspaceFiles(root, 'note');
    expect(partial.files.at(-1)?.path).toBe('note-directory/other.txt');
    expect(partial.files.some(entry => entry.path === '.hidden-note')).toBe(true);
    expect((await searchWorkspaceFiles(root, 'tracked/')).files.map(entry => entry.path)).toEqual(['tracked/Note.txt']);
  });
});

test('uses workspace-relative paths inside a repository subfolder and excludes symlinks', async () => {
  await fixture(async (root, file) => {
    git(root, 'init', '--quiet');
    await file('outside-note.txt'); await file('src/inside-note.txt');
    await createSymbolicLink(join(root, 'outside-note.txt'), join(root, 'src/link-note.txt'));
    await createSymbolicLink(root, join(root, 'src/escape'));
    expect((await searchWorkspaceFiles(join(root, 'src'), 'note')).files)
      .toEqual([{ name: 'inside-note.txt', path: 'inside-note.txt' }]);
  });
});

test('searches non-Git workspaces without reading file contents and ignores metadata and symbolic links', async () => {
  await fixture(async (root, file) => {
    await file('nested/큰 파일.txt', '\0'.repeat(2_000_000));
    await file('.hidden.txt'); await file('.git/private.txt');
    await createSymbolicLink(join(root, 'nested'), join(root, 'linked'));
    expect((await searchWorkspaceFiles(root, '큰 파일')).files).toEqual([{ path: 'nested/큰 파일.txt', name: '큰 파일.txt' }]);
    expect((await searchWorkspaceFiles(root, '.txt')).files.map(entry => entry.path)).toEqual(['.hidden.txt', 'nested/큰 파일.txt']);
    expect((await searchWorkspaceFiles(root, 'missing')).files).toEqual([]);
    expect(await searchWorkspaceFiles(root, '')).toEqual({ files: [], truncated: false });
  });
});

test('limits results with an explicit partial flag and reflects newly added files', async () => {
  await fixture(async (root, file) => {
    await Promise.all(Array.from({ length: 101 }, (_, index) => file(`item-${index}.txt`)));
    const result = await searchWorkspaceFiles(root, 'item');
    expect(result.files).toHaveLength(100); expect(result.truncated).toBe(true);
    await file('unique-item.txt');
    expect((await searchWorkspaceFiles(root, 'unique-item')).files).toHaveLength(1);
  });
});

test('validates request and response boundaries before exposing search results', async () => {
  for (const value of [null, {}, 'x'.repeat(257), 'bad\0query']) {
    expect(() => workspaceFileSearchQuery(value)).toThrow();
    await assert.rejects(searchWorkspaceFiles('/missing', value), /File search/);
  }
  const calls: unknown[][] = [];
  const validResponse = { files: [{ path: 'src/a.ts', name: 'a.ts' }], truncated: false };
  let response: unknown = validResponse;
  const api = createWorkspaceFileSearchApi({ invoke: async (...args: unknown[]) => { calls.push(args); return response; } });
  expect(await api.searchWorkspaceFiles(' a.ts ')).toEqual(validResponse);
  expect(calls).toEqual([['cheshi:search-workspace-files', 'a.ts']]);
  for (const path of ['../outside', '/absolute', '.git/config', 'C:/absolute', 'a\\b', 'a\0b']) {
    response = { files: [{ path, name: path.split('/').at(-1) }], truncated: false };
    await assert.rejects(api.searchWorkspaceFiles('a'), /Invalid file search/);
  }
  expect(() => workspaceFileSearchResult({ files: [], truncated: 'true' })).toThrow();
  expect(() => workspaceFileSearchResult({ files: [{ path: 'a.ts', name: 'b.ts' }], truncated: false })).toThrow();
});

test('IPC searches only the configured workspace and runtime packaging includes the new service', async () => {
  await fixture(async (root, file) => {
    await file('entry.txt');
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    registerWorkspaceFileIpcHandlers({ workspaceRoot: root, ipcMain: { handle: (name, handler) => { handlers.set(name, handler); } },
      clipboard: { writeText() {} }, shell: { async trashItem() {} } });
    const handler = handlers.get('cheshi:search-workspace-files');
    assert.ok(handler);
    const result = await handler({} as IpcMainInvokeEvent, 'entry');
    expect(result.files).toEqual([{ path: 'entry.txt', name: 'entry.txt' }]);
    await assert.rejects(async () => handler({} as IpcMainInvokeEvent, null), /File search/);
  });
  const config = await loadForgeConfiguration();
  assert.equal(typeof config.packagerConfig.ignore, 'function');
  const ignore = config.packagerConfig.ignore;
  assert.ok(typeof ignore === 'function');
  expect(ignore('/desktop/lib/workspace-file-search.mts')).toBe(false);
  expect(ignore('/desktop/shared/workspace-file-search.ts')).toBe(false);
});
