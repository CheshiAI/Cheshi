import { afterEach, expect, test } from 'bun:test';
import { copyFile, link as createHardLink, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasLibrary } from '../lib/canvas/canvas-library.mts';
import { CanvasFileLocations } from '../lib/canvas/canvas-file-locations.mts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const bytes = (label: string) => new Uint8Array(Buffer.from(`fig-kiwi${label}`));
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-move-'));
  directories.push(directory);
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const library = new CanvasLibrary(root, path.join(directory, 'data'));
  await library.session.selectRoot(root);
  await writeFile(path.join(root, 'before.fig'), bytes('before'));
  await library.read('before.fig');
  return { root, library };
}

test('external rename and later edits retain identity and update listing paths', async () => {
  const { root, library } = await fixture();
  await rename(path.join(root, 'before.fig'), path.join(root, '료혼진심관.fig'));
  await writeFile(path.join(root, '료혼진심관.fig'), bytes('new content'));
  const listing = await library.list();
  expect(listing.relocations).toEqual([{ previousPath: 'before.fig', path: '료혼진심관.fig' }]);
  expect((await library.read('료혼진심관.fig')).data).toEqual(bytes('new content'));
  expect((await library.list()).relocations).toEqual(listing.relocations);
});

test('moves across folders and repeated moves keep the original open path recoverable', async () => {
  const { root, library } = await fixture();
  await mkdir(path.join(root, 'nested'));
  await rename(path.join(root, 'before.fig'), path.join(root, 'nested/next.fig'));
  await library.list();
  await rename(path.join(root, 'nested/next.fig'), path.join(root, 'final.fig'));
  expect((await library.list()).relocations).toEqual([
    { previousPath: 'before.fig', path: 'final.fig' },
    { previousPath: 'nested/next.fig', path: 'final.fig' },
  ]);
});

test('a native atomic save records the new identity before an external rename', async () => {
  const { root, library } = await fixture();
  const document = await library.read('before.fig');
  await library.save({ path: document.path, expectedRevision: document.revision, data: bytes('saved') });
  await rename(path.join(root, 'before.fig'), path.join(root, 'after.fig'));
  expect((await library.list()).relocations).toEqual([{ previousPath: 'before.fig', path: 'after.fig' }]);
});

test('equal copies, deletions and ambiguous hard links are never guessed as renames', async () => {
  const { root, library } = await fixture();
  await copyFile(path.join(root, 'before.fig'), path.join(root, 'copy.fig'));
  await createHardLink(path.join(root, 'before.fig'), path.join(root, 'link-a.fig'));
  await createHardLink(path.join(root, 'before.fig'), path.join(root, 'link-b.fig'));
  await rm(path.join(root, 'before.fig'));
  expect((await library.list()).relocations).toEqual([]);
  await rm(path.join(root, 'link-a.fig'));
  await rm(path.join(root, 'link-b.fig'));
  expect((await library.list()).relocations).toEqual([]);
});

test('moving outside the selected canvas folder does not retarget an open tab', async () => {
  const { root, library } = await fixture();
  await mkdir(path.join(root, 'selected'));
  await library.session.selectRoot(path.join(root, 'selected'));
  await rename(path.join(root, 'before.fig'), path.join(root, 'elsewhere.fig'));
  expect((await library.list()).relocations).toEqual([]);
});

test('incomplete listings and unknown identities do not trigger relocation', () => {
  const locations = new CanvasFileLocations();
  locations.remember('old.fig', 'known');
  expect(locations.observe([{ path: 'next.fig', identity: 'known' }], true)).toEqual([]);
  expect(locations.observe([{ path: 'next.fig', identity: null }], false)).toEqual([]);
  expect(locations.observe([{ path: 'next.fig', identity: 'known' }], false)).toEqual([
    { previousPath: 'old.fig', path: 'next.fig' },
  ]);
});

test('an existing original path or reused filename is not redirected elsewhere', () => {
  const locations = new CanvasFileLocations();
  locations.remember('old.fig', 'old-file');
  expect(locations.observe([
    { path: 'old.fig', identity: 'replacement' }, { path: 'next.fig', identity: 'old-file' },
  ], false)).toEqual([]);
  expect(locations.observe([{ path: 'next.fig', identity: 'old-file' }], false)).toEqual([]);
});

test('identity cache stays bounded', () => {
  const locations = new CanvasFileLocations();
  for (let i = 0; i < 1001; i++) locations.remember(`${i}.fig`, `${i}`);
  expect(locations.observe([{ path: 'new.fig', identity: '0' }], false)).toEqual([]);
});
