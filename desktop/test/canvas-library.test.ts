import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasLibrary } from '../lib/canvas/canvas-library.mts';
import { canvasRevision } from '../lib/canvas/canvas-history.mts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const bytes = (label: string) => new Uint8Array(Buffer.from(`fig-kiwi${label}`));
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-library-'));
  directories.push(directory);
  const root = path.join(directory, 'workspace'), dataRoot = path.join(directory, 'data');
  await mkdir(root);
  return { root, dataRoot, service: new CanvasLibrary(root, dataRoot) };
}
async function rejects(operation: Promise<unknown>, pattern: RegExp) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(String(failure)).toMatch(pattern);
}

test('changed saves persist binary versions across restart and identical saves are deduplicated', async () => {
  const { root, dataRoot, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const second = await service.save({ path: first.path, data: bytes('two'), expectedRevision: first.revision, description: 'Agent: revised card' });
  await service.save({ path: first.path, data: bytes('two'), expectedRevision: second.revision });
  const restarted = new CanvasLibrary(root, dataRoot);
  const history = await restarted.history(first.path);
  expect(history.versions).toHaveLength(2);
  expect(history.versions[0]?.description).toBe('Agent: revised card');
  expect((await restarted.readVersion(first.path, history.versions[1]!.id)).data).toEqual(bytes('one'));
  expect(await readdir(root)).toEqual(['screen.fig']);
});

test('restore preserves external current content and records a new version without deleting later history', async () => {
  const { root, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const before = await service.history(first.path);
  await writeFile(path.join(root, first.path), bytes('agent edit'));
  const changed = canvasRevision(bytes('agent edit'));
  await service.restore({ path: first.path, versionId: before.versions[0]!.id, expectedRevision: changed });
  const history = await service.history(first.path);
  expect(history.versions.map(item => item.reason)).toEqual(['restored', 'before-restore', 'saved']);
  expect(history.versions[0]?.id).not.toBe(before.versions[0]!.id);
  expect((await service.readVersion(first.path, history.versions[1]!.id)).data).toEqual(bytes('agent edit'));
  expect(new Uint8Array(await readFile(path.join(root, first.path)))).toEqual(bytes('one'));
});

test('stale restores and saves leave a newer file intact', async () => {
  const { root, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const history = await service.history(first.path);
  await writeFile(path.join(root, first.path), bytes('newer'));
  await rejects(service.restore({ path: first.path, versionId: history.versions[0]!.id, expectedRevision: first.revision }), /changed on disk/);
  await rejects(service.save({ path: first.path, data: bytes('stale'), expectedRevision: first.revision }), /changed on disk/);
  expect(new Uint8Array(await readFile(path.join(root, first.path)))).toEqual(bytes('newer'));
});

test('separate service instances serialize conflicting saves', async () => {
  const { root, dataRoot, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const competitor = new CanvasLibrary(root, dataRoot);
  const results = await Promise.allSettled([
    service.save({ path: first.path, data: bytes('two'), expectedRevision: first.revision }),
    competitor.save({ path: first.path, data: bytes('three'), expectedRevision: first.revision }),
  ]);
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect((await service.history(first.path)).versions).toHaveLength(2);
});

test('checkpoint and watcher capture external edits, including when the editor is closed', async () => {
  const { root, service } = await fixture();
  await writeFile(path.join(root, 'screen.fig'), bytes('before'));
  await service.checkpoint({ path: 'screen.fig', description: 'Before agent work' });
  await writeFile(path.join(root, 'screen.fig'), bytes('after'));
  await service.captureChanged({ paths: ['screen.fig', 'other.txt'], overflow: false });
  await service.captureChanged({ paths: ['screen.fig'], overflow: false });
  const history = await service.history('screen.fig');
  expect(history.versions).toHaveLength(2);
  expect(history.versions[1]?.description).toBe('Before agent work');
  expect(history.versions[0]?.reason).toBe('external');
});

test('listing is workspace scoped, includes ignored design folders and excludes symlinks and dependencies', async () => {
  const { root, dataRoot, service } = await fixture();
  for (const name of ['designs', 'node_modules', '.git']) {
    await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'screen.fig'), bytes(name));
  }
  await createSymbolicLink(path.join(root, 'designs'), path.join(root, 'linked'));
  await createSymbolicLink(path.join(root, 'designs', 'screen.fig'), path.join(root, 'file-link.fig'));
  await service.session.selectRoot('.');
  const listing = await service.list();
  expect(listing.files.map(file => file.path)).toEqual(['designs/screen.fig']);
  expect(listing.workspaceRoot).toBe(await realpath(root));
  expect(listing.historyDirectory.startsWith(dataRoot)).toBe(true);
  await rejects(service.history('../outside.fig'), /workspace|relative/i);
  await rejects(service.read('file-link.fig'), /symbolic/i);
  await rejects(service.readVersion('designs/screen.fig', '../../outside'), /not found/);
  const otherRoot = path.join(root, 'another'); await mkdir(otherRoot);
  expect(new CanvasLibrary(otherRoot, dataRoot).versions.directory).not.toBe(service.versions.directory);
});

test('an interrupted published save is recovered from the journal; unpublished attempts are not listed', async () => {
  const { root, dataRoot, service } = await fixture();
  await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const index = await service.versions.load('screen.fig');
  const document = { path: index.path, data: bytes('two'), revision: canvasRevision(bytes('two')) };
  index.pending = await service.versions.prepare(document, 'saved', 'Recovered save');
  await service.versions.persist(index);
  await writeFile(path.join(root, index.path), document.data);
  const restarted = new CanvasLibrary(root, dataRoot);
  expect((await restarted.history(index.path)).versions[0]?.description).toBe('Recovered save');
  const next = await restarted.versions.load(index.path);
  next.pending = await restarted.versions.prepare({ ...document, data: bytes('three'), revision: canvasRevision(bytes('three')) }, 'saved', 'Unpublished');
  await restarted.versions.persist(next);
  expect((await new CanvasLibrary(root, dataRoot).history(index.path)).versions).toHaveLength(2);
});

test('corrupt history blocks overwriting the original and corrupt blobs cannot be restored', async () => {
  const { root, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const history = await service.history(first.path);
  const folder = path.join(service.versions.directory, (await readdir(service.versions.directory))[0]!);
  await writeFile(path.join(folder, `${first.revision}.fig`), bytes('damaged'));
  await rejects(service.restore({ path: first.path, versionId: history.versions[0]!.id, expectedRevision: first.revision }), /damaged/);
  await writeFile(path.join(folder, 'history.json'), JSON.stringify({ version: 99 }));
  await rejects(service.save({ path: first.path, data: bytes('two'), expectedRevision: first.revision }), /damaged/);
  expect(new Uint8Array(await readFile(path.join(root, first.path)))).toEqual(bytes('one'));
});

test('a deleted file can be restored without dropping its version history', async () => {
  const { root, service } = await fixture();
  await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const history = await service.history('screen.fig');
  await rm(path.join(root, 'screen.fig'));
  expect((await service.history('screen.fig')).currentRevision).toBeNull();
  await service.restore({ path: 'screen.fig', versionId: history.versions[0]!.id, expectedRevision: null });
  expect((await service.history('screen.fig')).versions).toHaveLength(2);
});

test('only the chosen canvas folder is listed after restart; links cannot escape the workspace', async () => {
  const { root, dataRoot, service } = await fixture();
  for (const name of ['designs', 'elsewhere']) {
    await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'screen.fig'), bytes(name));
  }
  expect((await service.list()).files).toEqual([]);
  await service.session.selectRoot(path.join(root, 'designs'));
  const restarted = new CanvasLibrary(root, dataRoot);
  expect((await restarted.list()).files.map(item => item.path)).toEqual(['designs/screen.fig']);
  expect((await restarted.list()).canvasRoot).toBe('designs');
  await createSymbolicLink(path.dirname(root), path.join(root, 'escape'));
  await rejects(service.session.selectRoot('escape'), /symbolic/i);
  expect((await service.list()).canvasRoot).toBe('designs');
});

test('rename preserves version identities, file contents, remembered document and later restores', async () => {
  const { root, dataRoot, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  const second = await service.save({ path: first.path, data: bytes('two'), expectedRevision: first.revision });
  await service.session.remember(first.path);
  const versions = (await service.history(first.path)).versions;
  const renamed = await service.rename({ path: first.path, name: 'renamed', expectedRevision: second.revision });
  expect(renamed.path).toBe('renamed.fig');
  expect(await readdir(root)).toEqual(['renamed.fig']);
  const restarted = new CanvasLibrary(root, dataRoot);
  expect(await restarted.session.read()).toBe(renamed.path);
  expect((await restarted.history(renamed.path)).versions).toEqual(versions);
  await restarted.restore({ path: renamed.path, versionId: versions[1]!.id, expectedRevision: second.revision });
  expect((await restarted.read(renamed.path)).data).toEqual(bytes('one'));
  expect((await restarted.history(renamed.path)).versions).toHaveLength(3);
});

test('rename rejects duplicate, unsafe and stale requests and serializes competing renames', async () => {
  const { root, dataRoot, service } = await fixture();
  const first = await service.save({ path: 'screen.fig', data: bytes('one'), expectedRevision: null });
  await service.save({ path: 'existing.fig', data: bytes('other'), expectedRevision: null });
  await rejects(service.rename({ path: first.path, name: 'existing' }), /exist/i);
  await rejects(service.rename({ path: first.path, name: '../outside' }), /file name/);
  await rejects(service.rename({ path: first.path, name: 'next', expectedRevision: 'stale' }), /changed on disk/);
  expect((await service.read('existing.fig')).data).toEqual(bytes('other'));
  const competitor = new CanvasLibrary(root, dataRoot);
  const results = await Promise.allSettled([
    service.rename({ path: first.path, name: 'one' }), competitor.rename({ path: first.path, name: 'two' }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await readdir(root)).length).toBe(2);
});
