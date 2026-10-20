import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SceneGraph } from '@open-pencil/scene-graph';
import { exportFigFile, parseFigFile } from '@open-pencil/core/io/formats/fig';
import { CanvasDocuments } from '../lib/canvas/canvas-documents.mts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-'));
  directories.push(root);
  const graph = new SceneGraph();
  const page = graph.getPages()[0]!;
  graph.createNode('TEXT', page.id, { name: 'Greeting', text: '체시 디자인', fontFamily: 'Nanum Gothic', x: 32, y: 48, width: 240, height: 32 });
  return { root, service: new CanvasDocuments(root), data: await exportFigFile(graph) };
}
async function rejects(operation: Promise<unknown>, pattern: RegExp) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(pattern);
}

test('native OpenPencil file survives disk save and reopen with Korean text and geometry', async () => {
  const { service, data } = await fixture();
  const saved = await service.save({ path: 'design.fig', data, expectedRevision: null });
  const reopened = await service.read(saved.path);
  expect(reopened.revision).toBe(saved.revision);
  const graph = await parseFigFile(new Uint8Array(reopened.data).buffer);
  const text = [...graph.getAllNodes()].find(node => node.type === 'TEXT');
  expect(text?.text).toBe('체시 디자인');
  expect(text?.x).toBe(32);
  expect(text?.y).toBe(48);
});

test('new saves never overwrite an existing file and stale revisions preserve external edits', async () => {
  const { root, service, data } = await fixture();
  const saved = await service.save({ path: 'design.fig', data, expectedRevision: null });
  await rejects(service.save({ path: 'design.fig', data, expectedRevision: null }), /exist/i);
  const changed = Buffer.concat([data, Buffer.from('external edit')]);
  await writeFile(path.join(root, 'design.fig'), changed);
  await rejects(service.save({ path: 'design.fig', data, expectedRevision: saved.revision }), /changed on disk/);
  expect(await readFile(path.join(root, 'design.fig'))).toEqual(changed);
  expect(await readdir(root)).toEqual(['design.fig']);
});

test('rejects paths outside the workspace, metadata, invalid formats and symlinks', async () => {
  const { root, service, data } = await fixture();
  for (const filename of ['../escape.fig', '/tmp/escape.fig', '.git/config.fig', 'code.ts']) {
    await rejects(service.save({ path: filename, data, expectedRevision: null }), /workspace|relative|root/i);
  }
  await rejects(service.save({ path: 'invalid.fig', data: new Uint8Array(16), expectedRevision: null }), /not a .fig/);
  await writeFile(path.join(root, 'target.fig'), data);
  await createSymbolicLink(path.join(root, 'target.fig'), path.join(root, 'link.fig'));
  await rejects(service.read('link.fig'), /symbolic/i);
  await rejects(service.save({ path: 'link.fig', data, expectedRevision: null }), /symbolic/i);
});

test('simultaneous saves with the same revision accept only the first change', async () => {
  const { service, data } = await fixture();
  const saved = await service.save({ path: 'design.fig', data, expectedRevision: null });
  const first = Buffer.concat([data, Buffer.from('first')]);
  const next = service.save({ path: 'design.fig', data: first, expectedRevision: saved.revision });
  const stale = service.save({ path: 'design.fig', data, expectedRevision: saved.revision });
  await next;
  await rejects(stale, /changed on disk/);
  expect((await service.read('design.fig')).data).toEqual(new Uint8Array(first));
});
