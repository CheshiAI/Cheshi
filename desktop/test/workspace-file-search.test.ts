import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceFileSearch } from '../lib/workspace-file-search.mts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

describe('workspace filename search', () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    [root, outside] = await Promise.all([
      mkdtemp(path.join(tmpdir(), 'cheshi-file-search-')),
      mkdtemp(path.join(tmpdir(), 'cheshi-file-search-outside-')),
    ]);
  });
  afterEach(async () => {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
  async function addFile(relative: string) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, 'fixture');
  }

  it('matches case-insensitive basenames before path matches and normalizes path separators', async () => {
    await Promise.all(['src/App.ts', 'src/App.tsx', 'src/MyApp.ts', 'App.ts/other.ts'].map(addFile));
    const search = createWorkspaceFileSearch(root);
    expect((await search('APP.TS')).files.map(file => file.path)).toEqual([
      'src/App.ts', 'src/App.tsx', 'src/MyApp.ts', 'App.ts/other.ts',
    ]);
    expect((await search('  src\\app  ')).files.map(file => file.name)).toEqual(['App.ts', 'App.tsx']);
  });

  it('returns sorted relative paths for an empty query and preserves dot source files', async () => {
    await Promise.all(['z.ts', 'a.ts', '.config/tool.ts', '.env.example'].map(addFile));
    expect(await createWorkspaceFileSearch(root)('')).toEqual({
      files: [
        { path: '.config/tool.ts', name: 'tool.ts' },
        { path: '.env.example', name: '.env.example' },
        { path: 'a.ts', name: 'a.ts' },
        { path: 'z.ts', name: 'z.ts' },
      ], truncated: false,
    });
  });

  it('skips dependencies, generated folders and all symbolic links', async () => {
    await Promise.all(['src/keep.ts', '.git/config', 'node_modules/package/index.ts', 'dist/app.ts',
      'native/.build/output', 'out/app.js', 'vendor/library.ts'].map(addFile));
    await writeFile(path.join(outside, 'private.ts'), 'outside');
    await Promise.all([
      createSymbolicLink(outside, path.join(root, 'external-directory')),
      createSymbolicLink(path.join(outside, 'private.ts'), path.join(root, 'external.ts')),
      createSymbolicLink(path.join(root, 'src'), path.join(root, 'linked-source')),
    ]);
    expect(await createWorkspaceFileSearch(root)('')).toEqual({
      files: [{ path: 'src/keep.ts', name: 'keep.ts' }], truncated: false,
    });
  });

  it('limits returned matches and reports truncation without truncating a narrow search', async () => {
    await Promise.all(Array.from({ length: 105 }, (_, index) => addFile(`file-${String(index).padStart(3, '0')}.ts`)));
    const search = createWorkspaceFileSearch(root);
    const broad = await search('file');
    expect(broad.files).toHaveLength(100);
    expect(broad.truncated).toBe(true);
    expect(await search('file-104.ts')).toEqual({
      files: [{ path: 'file-104.ts', name: 'file-104.ts' }], truncated: false,
    });
  });

  it('bounds the inventory and reports incomplete scans', async () => {
    await Promise.all(['a.ts', 'b.ts', 'c.ts'].map(addFile));
    const limited = await createWorkspaceFileSearch(root, { maxEntries: 1 })('');
    expect(limited.files).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(await createWorkspaceFileSearch(root, { maxDurationMs: 0 })('')).toEqual({ files: [], truncated: true });
  });

  it('shares a cached inventory across queries and refreshes after expiry', async () => {
    let time = 100;
    const search = createWorkspaceFileSearch(root, { now: () => time, cacheMs: 50 });
    await addFile('first.ts');
    const [first, missing] = await Promise.all([search('first'), search('second')]);
    expect(first.files).toHaveLength(1);
    expect(missing.files).toHaveLength(0);
    first.files[0]!.path = 'changed-by-consumer';
    await addFile('second.ts');
    expect((await search('first')).files[0]!.path).toBe('first.ts');
    expect((await search('second')).files).toHaveLength(0);
    time += 51;
    expect((await search('second')).files).toEqual([{ path: 'second.ts', name: 'second.ts' }]);
  });

  it('rejects malformed queries and unavailable or relative workspace roots', async () => {
    const search = createWorkspaceFileSearch(root);
    for (const query of [null, true, {}, 'a'.repeat(257), 'bad\0query']) {
      await expectFailure(search(query), 'query');
    }
    expect((await search('../private')).files).toEqual([]);
    await expectFailure(createWorkspaceFileSearch('relative')(''), 'absolute');
    await expectFailure(createWorkspaceFileSearch(path.join(root, 'missing'))(''), 'unavailable');
  });

  it('registers the IPC handler against the selected workspace and validates input there', async () => {
    type Listener = Parameters<Parameters<typeof registerWorkspaceFileIpcHandlers>[0]['ipcMain']['handle']>[1];
    const handlers = new Map<string, Listener>();
    registerWorkspaceFileIpcHandlers({
      ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
      workspaceRoot: root,
      clipboard: { writeText: () => {} },
      shell: { trashItem: async () => {} },
    });
    await addFile('selected.ts');
    const handler = handlers.get('cheshi:search-workspace-files')!;
    const event = {} as Parameters<Listener>[0];
    expect(await handler(event, 'selected')).toEqual({
      files: [{ path: 'selected.ts', name: 'selected.ts' }], truncated: false,
    });
    await expectFailure(Promise.resolve(handler(event, false)), 'query');
  });
});
