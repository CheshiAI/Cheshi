import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { openPencilTreeHash, prepareOpenPencilSource } from '../../scripts/open-pencil-source.mts';
import { originalEditorAdaptations } from '../frontend/open-pencil/source-adaptations';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test('canvas lifecycle keeps presentation transparent without changing document colors or losing GL cleanup', async () => {
  const transform = originalEditorAdaptations().transform;
  if (typeof transform !== 'function') throw new Error('Expected source transform');
  const source = `function lifecycle(state, editor, view, stopStickyPlaceholder, releaseGLContext) {
  function renderNow() {
    state.renderer.renderFromEditorState(
      view,
      editor.graph,
    )
  }
  function destroy() {
    stopStickyPlaceholder()
    releaseGLContext()
  }

  return { renderNow, destroy }
}`;
  const result: unknown = await Reflect.apply(transform, {}, [source,
    '/project/vendor/open-pencil/packages/vue/src/canvas/surface/lifecycle.ts']);
  if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'string') {
    throw new Error('Expected transformed lifecycle');
  }
  const rendered: Array<{ pageColor: { r: number; g: number; b: number; a: number } }> = [];
  const events: string[] = [];
  const graph = { fills: [{ color: '#f7f5ef' }] };
  const view = { pageColor: { r: 0.12, g: 0.12, b: 0.12, a: 1 } };
  const lifecycle = runInNewContext(`${result.code}; lifecycle(state, editor, view, stop, release)`, {
    state: {
      renderer: { renderFromEditorState: (value: typeof view, document: typeof graph) => {
        rendered.push(value); expect(document).toBe(graph);
      } },
      glCanvas: { getContext: () => ({ getExtension: () => ({ loseContext: () => events.push('lose') }) }) },
    }, editor: { graph }, view, stop: () => events.push('stop'), release: () => events.push('release'),
  }) as { renderNow(): void; destroy(): void };
  lifecycle.renderNow();
  view.pageColor = { r: 0.96, g: 0.96, b: 0.96, a: 1 };
  lifecycle.renderNow();
  expect(rendered.map(value => value.pageColor)).toEqual([
    { r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 },
  ]);
  expect(view.pageColor).toEqual({ r: 0.96, g: 0.96, b: 0.96, a: 1 });
  expect(graph.fills).toEqual([{ color: '#f7f5ef' }]);
  lifecycle.destroy();
  expect(events).toEqual(['stop', 'release', 'lose']);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cheshi-open-pencil-test-'));
  directories.push(root);
  const vendor = path.join(root, 'vendor');
  const commit = '1'.repeat(40);
  const upstream = path.join(root, `open-pencil-${commit}`);
  await mkdir(path.join(upstream, 'src'), { recursive: true });
  await mkdir(vendor);
  await writeFile(path.join(upstream, 'package.json'), '{"version":"0.16.0"}\n');
  await writeFile(path.join(upstream, 'src', 'App.vue'), '<template>Test editor</template>\n');
  await writeFile(path.join(upstream, 'LICENSE'), 'Test license\n');
  const archive = path.join(root, 'source.tar.gz');
  await execute('tar', ['-czf', archive, '-C', root, path.basename(upstream)]);
  const bytes = new Uint8Array(await readFile(archive));
  const pin = {
    repository: 'https://github.com/open-pencil/open-pencil', commit, version: '0.16.0',
    source: `https://codeload.github.com/open-pencil/open-pencil/tar.gz/${commit}`,
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    treeSha256: await openPencilTreeHash(upstream), localPatches: [],
  };
  const pinFile = path.join(vendor, 'open-pencil.version.json');
  await writeFile(pinFile, JSON.stringify(pin));
  return { root, vendor, upstream, bytes, pin, pinFile, target: path.join(vendor, 'open-pencil') };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('prepares the pinned archive atomically and reuses the verified tree without network', async () => {
  const f = await fixture();
  let downloads = 0;
  const first = await prepareOpenPencilSource(f.root, { download: async url => {
    expect(url).toBe(f.pin.source); downloads++; return f.bytes;
  } });
  expect(first.reused).toBe(false);
  expect(await readFile(path.join(f.target, 'src/App.vue'), 'utf8')).toBe('<template>Test editor</template>\n');
  expect(await readFile(path.join(f.target, 'LICENSE'), 'utf8')).toBe('Test license\n');
  const second = await prepareOpenPencilSource(f.root, { download: async () => { throw new Error('Offline'); } });
  expect(second.reused).toBe(true);
  expect(downloads).toBe(1);
  expect((await readdir(f.vendor)).sort()).toEqual(['open-pencil', 'open-pencil.version.json']);
});

test('preserves locally edited source instead of overwriting it', async () => {
  const f = await fixture();
  await cp(f.upstream, f.target, { recursive: true });
  await writeFile(path.join(f.target, 'src/App.vue'), 'Local work');
  let downloaded = false;
  await expectFailure(prepareOpenPencilSource(f.root, { download: async () => { downloaded = true; return f.bytes; } }), 'Existing files were retained');
  expect(downloaded).toBe(false);
  expect(await readFile(path.join(f.target, 'src/App.vue'), 'utf8')).toBe('Local work');
});

test('checksum failures leave no installed or partial source directory', async () => {
  const f = await fixture();
  await expectFailure(prepareOpenPencilSource(f.root, { download: async () => new Uint8Array([1, 2, 3]) }), 'archive checksum mismatch');
  expect(await readdir(f.vendor)).toEqual(['open-pencil.version.json']);
  await writeFile(f.pinFile, JSON.stringify({ ...f.pin, treeSha256: '0'.repeat(64) }));
  await expectFailure(prepareOpenPencilSource(f.root, { download: async () => f.bytes }), 'source differs');
  expect(await readdir(f.vendor)).toEqual(['open-pencil.version.json']);
});

test('an interrupted download can be retried and does not leave partial source', async () => {
  const f = await fixture();
  await expectFailure(prepareOpenPencilSource(f.root, { download: async () => { throw new Error('Network interrupted'); } }), 'Network interrupted');
  expect(await readdir(f.vendor)).toEqual(['open-pencil.version.json']);
  expect((await prepareOpenPencilSource(f.root, { download: async () => f.bytes })).reused).toBe(false);
});

test('rejects an archive with an unexpected root before extracting files', async () => {
  const f = await fixture();
  const archive = path.join(f.root, 'unexpected.tar.gz');
  await execute('tar', ['-czf', archive, '-C', f.upstream, 'src']);
  const bytes = new Uint8Array(await readFile(archive));
  await writeFile(f.pinFile, JSON.stringify({ ...f.pin, archiveSha256: createHash('sha256').update(bytes).digest('hex') }));
  await expectFailure(prepareOpenPencilSource(f.root, { download: async () => bytes }), 'unexpected path');
  expect(await readdir(f.vendor)).toEqual(['open-pencil.version.json']);
});

test('rejects unpinned download URLs before requesting them', async () => {
  const f = await fixture();
  await writeFile(f.pinFile, JSON.stringify({ ...f.pin, source: 'https://example.com/latest.tar.gz' }));
  let downloaded = false;
  await expectFailure(prepareOpenPencilSource(f.root, { download: async () => { downloaded = true; return f.bytes; } }), 'Invalid OpenPencil source pin');
  expect(downloaded).toBe(false);
});

test('concurrent preparations publish one verified tree and remove their staging directories', async () => {
  const f = await fixture();
  const results = await Promise.all([prepareOpenPencilSource(f.root, { download: async () => f.bytes }),
    prepareOpenPencilSource(f.root, { download: async () => f.bytes })]);
  expect(results.filter(result => !result.reused).length).toBe(1);
  expect(await openPencilTreeHash(f.target)).toBe(f.pin.treeSha256);
  expect((await readdir(f.vendor)).sort()).toEqual(['open-pencil', 'open-pencil.version.json']);
});

test('rejects a symlinked source directory and preserves the original target', async () => {
  const f = await fixture();
  await createSymbolicLink(f.upstream, f.target);
  await expectFailure(prepareOpenPencilSource(f.root), 'symbolic links');
  expect(await openPencilTreeHash(f.upstream)).toBe(f.pin.treeSha256);
});

test('Git excludes downloaded source and staging while retaining the pin and adapters', async () => {
  const f = await fixture();
  await execute('git', ['init', '--quiet', f.root]);
  await cp(new URL('../../.gitignore', import.meta.url), path.join(f.root, '.gitignore'));
  const { stdout } = await execute('git', ['check-ignore', '--no-index', '--',
    'vendor/open-pencil/src/App.vue', 'vendor/.open-pencil-test/source.tar.gz',
    'vendor/open-pencil.version.json', 'desktop/frontend/open-pencil/source-adaptations.ts'], { cwd: f.root });
  expect(stdout.trim().split('\n')).toEqual(['vendor/open-pencil/src/App.vue', 'vendor/.open-pencil-test/source.tar.gz']);
});
