import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCachedEditor } from '../../scripts/open-pencil-build-cache.mts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cheshi-editor-cache-'));
  directories.push(root);
  await writeFile(path.join(root, 'source.ts'), 'one');
  await writeFile(path.join(root, 'dependencies.lock'), 'one');
  let builds = 0;
  const options = {
    root, output: path.join(root, 'public/editor'), inputs: ['source.ts', 'dependencies.lock'], toolchain: 'test-v1',
    build: async (directory: string) => {
      builds++;
      await writeFile(path.join(directory, 'index.html'), `build ${builds}`);
      await writeFile(path.join(directory, 'asset.js'), 'asset');
    },
  };
  return { options, builds: () => builds, cache: path.join(root, 'node_modules/.cache/cheshi-open-pencil') };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('reuses verified output and detects content changes even with identical size and timestamps', async () => {
  const f = await fixture();
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  expect((await buildCachedEditor(f.options)).reused).toBe(true);
  const source = path.join(f.options.root, 'source.ts');
  const before = await stat(source);
  await writeFile(source, 'two');
  await utimes(source, before.atime, before.mtime);
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  await writeFile(path.join(f.options.root, 'dependencies.lock'), 'two');
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  expect((await buildCachedEditor({ ...f.options, toolchain: 'test-v2' })).reused).toBe(false);
  expect(f.builds()).toBe(4);
});

test('rebuilds missing, tampered or extra output, and corrupt cache metadata', async () => {
  const f = await fixture();
  await buildCachedEditor(f.options);
  await rm(path.join(f.options.output, 'asset.js'));
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  await writeFile(path.join(f.options.output, 'asset.js'), 'wrong');
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  await writeFile(path.join(f.options.output, 'extra.js'), 'stale');
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  await writeFile(path.join(f.cache, 'build.json'), '{broken');
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
  await rm(f.options.output, { recursive: true });
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
});

test('failed, incomplete and stale compilations preserve the last successful bundle', async () => {
  const f = await fixture();
  await buildCachedEditor(f.options);
  await expectFailure(buildCachedEditor({ ...f.options, force: true, build: async () => { throw new Error('Compile failed'); } }), 'Compile failed');
  await expectFailure(buildCachedEditor({ ...f.options, force: true, build: async () => {} }), 'index.html');
  await expectFailure(buildCachedEditor({ ...f.options, force: true, build: async directory => {
    await f.options.build(directory);
    await writeFile(path.join(f.options.root, 'source.ts'), 'changed while building');
  } }), 'inputs changed');
  expect(await readFile(path.join(f.options.output, 'index.html'), 'utf8')).toBe('build 1');
  expect((await buildCachedEditor(f.options)).reused).toBe(false);
});

test('restores an interrupted publication before preparation, even when preparation fails', async () => {
  const f = await fixture();
  await buildCachedEditor(f.options);
  await rename(f.options.output, path.join(f.cache, 'previous'));
  await expectFailure(buildCachedEditor({ ...f.options, prepare: async () => { throw new Error('Offline'); } }), 'Offline');
  expect(await readFile(path.join(f.options.output, 'index.html'), 'utf8')).toBe('build 1');
  expect((await buildCachedEditor(f.options)).reused).toBe(true);
});

test('serializes concurrent builds and reuses the winner', async () => {
  const f = await fixture();
  const entered = createDeferred();
  const finish = createDeferred();
  const first = buildCachedEditor({ ...f.options, build: async directory => {
    entered.resolve(); await finish.promise; await f.options.build(directory);
  } });
  await entered.promise;
  const second = buildCachedEditor(f.options);
  finish.resolve();
  expect((await first).reused).toBe(false);
  expect((await second).reused).toBe(true);
  expect(f.builds()).toBe(1);
});

test('recovers an abandoned lock with concurrent contenders', async () => {
  const f = await fixture();
  await mkdir(f.cache, { recursive: true });
  // An incomplete lock left before its owner was written is stale after the timeout.
  const lock = path.join(f.cache, 'build.lock');
  await writeFile(lock, '');
  await utimes(lock, new Date(0), new Date(0));
  const results = await Promise.all([buildCachedEditor(f.options), buildCachedEditor(f.options), buildCachedEditor(f.options)]);
  expect(results.filter(result => !result.reused)).toHaveLength(1);
  expect(f.builds()).toBe(1);
});

test('force rebuild requires literal true and preparation runs on cache hits', async () => {
  const f = await fixture();
  let preparations = 0;
  const options = { ...f.options, prepare: async () => { preparations++; } };
  await buildCachedEditor(options);
  expect((await buildCachedEditor({ ...options, force: 'true' as unknown as boolean })).reused).toBe(true);
  expect((await buildCachedEditor({ ...options, force: true })).reused).toBe(false);
  expect(preparations).toBe(3);
  expect(f.builds()).toBe(2);
});

test('successive rebuilds retain the complete lazy module graph of an already open document', async () => {
  const f = await fixture();
  let version = 0;
  const options = { ...f.options, build: async (directory: string) => {
    const hash = String(++version).padStart(8, '0');
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'index.html'), `<script src="./assets/index-${hash}.js"></script>`);
    const files = {
      [`index-${hash}.js`]: `export const history = () => import('./CanvasHistoryPanel-${hash}.js');`,
      [`CanvasHistoryPanel-${hash}.js`]: `import {value} from './shared-${hash}.js'; export {value};`,
      [`shared-${hash}.js`]: `export const value = ${version};`,
      [`history-${hash}.css`]: `.history { --version: ${version}; }`,
      [`worker-${hash}.js`]: `postMessage(${version});`,
      [`font-${hash}.woff2`]: `font ${version}`,
    };
    for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, 'assets', name), contents);
  } };
  await buildCachedEditor(options);
  const first = await readFile(path.join(options.output, 'assets/CanvasHistoryPanel-00000001.js'), 'utf8');
  for (let i = 0; i < 2; i++) await buildCachedEditor({ ...options, force: true });
  expect(await readFile(path.join(options.output, 'index.html'), 'utf8')).toContain('index-00000003.js');
  expect(await readFile(path.join(options.output, 'assets/CanvasHistoryPanel-00000001.js'), 'utf8')).toBe(first);
  expect(await readFile(path.join(options.output, 'assets/shared-00000001.js'), 'utf8')).toContain('value = 1');
  expect(await readFile(path.join(options.output, 'assets/history-00000001.css'), 'utf8')).toContain('--version: 1');
  expect(await readFile(path.join(options.output, 'assets/worker-00000001.js'), 'utf8')).toContain('postMessage(1)');
  expect(await readFile(path.join(options.output, 'assets/font-00000001.woff2'), 'utf8')).toBe('font 1');
  expect((await buildCachedEditor(options)).reused).toBe(true);
});

test('retention excludes untracked, modified and mutable assets', async () => {
  const f = await fixture();
  await buildCachedEditor({ ...f.options, build: async directory => {
    await f.options.build(directory);
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'assets/verified-12345678.js'), 'verified');
    await writeFile(path.join(directory, 'assets/modified-12345678.js'), 'original');
    await writeFile(path.join(directory, 'assets/mutable.js'), 'old mutable');
  } });
  await writeFile(path.join(f.options.output, 'assets/modified-12345678.js'), 'modified outside build');
  await writeFile(path.join(f.options.output, 'assets/untracked-12345678.js'), 'untracked');
  await buildCachedEditor({ ...f.options, force: true });
  expect(await readFile(path.join(f.options.output, 'assets/verified-12345678.js'), 'utf8')).toBe('verified');
  for (const name of ['modified-12345678.js', 'untracked-12345678.js', 'mutable.js']) {
    await expectFailure(readFile(path.join(f.options.output, 'assets', name)), 'ENOENT');
  }
  expect((await buildCachedEditor(f.options)).reused).toBe(true);
});

test('a hash collision fails publication and keeps the previous editor usable', async () => {
  const f = await fixture();
  const build = async (directory: string, value: string) => {
    await f.options.build(directory);
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'assets/history-12345678.js'), value);
  };
  await buildCachedEditor({ ...f.options, build: directory => build(directory, 'first') });
  const previousHtml = await readFile(path.join(f.options.output, 'index.html'), 'utf8');
  await expectFailure(buildCachedEditor({ ...f.options, force: true, build: directory => build(directory, 'second') }), 'without a new hash');
  expect(await readFile(path.join(f.options.output, 'assets/history-12345678.js'), 'utf8')).toBe('first');
  expect(await readFile(path.join(f.options.output, 'index.html'), 'utf8')).toBe(previousHtml);
});
