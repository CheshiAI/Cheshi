import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';
import { CanvasSession } from '../lib/canvas/canvas-session.mts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'cheshi-canvas-session-'));
  directories.push(base);
  const root = path.join(base, 'project'), other = path.join(base, 'other'), dataRoot = path.join(base, 'data');
  await Promise.all([mkdir(root), mkdir(other)]);
  await writeFile(path.join(root, 'one.fig'), 'fig-kiwi-test');
  await writeFile(path.join(root, 'two.fig'), 'fig-kiwi-next');
  return { root, other, dataRoot, session: new CanvasSession(dataRoot, root),
    stateFile: path.join(path.dirname(codeGraphStorageDirectory(dataRoot, root)), 'canvas-session.json') };
}
async function rejects(operation: Promise<unknown>) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
}

test('last document survives a native Node process restart and stays workspace scoped', async () => {
  const { root, other, dataRoot, session } = await fixture();
  expect(await session.read()).toBeNull();
  await session.remember('one.fig');
  const moduleUrl = new URL('../lib/canvas/canvas-session.mts', import.meta.url).href;
  const output = execFileSync('node', ['--input-type=module', '-e',
    `const {CanvasSession}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await new CanvasSession(${JSON.stringify(dataRoot)},${JSON.stringify(root)}).read()));`], { encoding: 'utf8' });
  expect(JSON.parse(output)).toBe('one.fig');
  expect(await new CanvasSession(dataRoot, other).read()).toBeNull();
});

test('new design clears only the remembered path and leaves saved documents intact', async () => {
  const { root, dataRoot, session } = await fixture();
  await session.remember('one.fig');
  await session.remember(null);
  expect(await new CanvasSession(dataRoot, root).read()).toBeNull();
  expect(await readFile(path.join(root, 'one.fig'), 'utf8')).toBe('fig-kiwi-test');
});

test('failed or unsafe paths never replace the last successful document', async () => {
  const { session } = await fixture();
  await session.remember('one.fig');
  for (const filename of ['missing.fig', '../escape.fig', '/tmp/escape.fig', '.git/secret.fig', 'source.ts']) {
    await rejects(session.remember(filename));
    expect(await session.read()).toBe('one.fig');
  }
  await session.remember('two.fig');
  expect(await session.read()).toBe('two.fig');
});

test('ordered remember and clear requests preserve the last user action', async () => {
  const { session } = await fixture();
  await Promise.all([session.remember('one.fig'), session.remember(null), session.remember('two.fig')]);
  expect(await session.read()).toBe('two.fig');
});

test('missing documents retain a retryable reference and malformed state can be cleared', async () => {
  const { root, dataRoot, session, stateFile } = await fixture();
  await session.remember('one.fig');
  await rm(path.join(root, 'one.fig'));
  expect(await new CanvasSession(dataRoot, root).read()).toBe('one.fig');
  for (const value of ['{broken', JSON.stringify({ version: 1, path: '../escape.fig' }), JSON.stringify({ version: 2, path: 'two.fig' })]) {
    await writeFile(stateFile, value);
    await rejects(session.read());
  }
  await session.remember(null);
  expect(await session.read()).toBeNull();
});

test('canvas folder persists across a native process restart and new paths stay inside it', async () => {
  const { root, dataRoot, session } = await fixture();
  await mkdir(path.join(root, 'designs'));
  expect(await session.root()).toBeNull();
  await rejects(session.newPath('screen'));
  await session.selectRoot(path.join(root, 'designs'));
  await session.remember('one.fig');
  expect(await session.newPath('screen')).toBe('designs/screen.fig');
  const moduleUrl = new URL('../lib/canvas/canvas-session.mts', import.meta.url).href;
  const output = execFileSync('node', ['--input-type=module', '-e',
    `const {CanvasSession}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await new CanvasSession(${JSON.stringify(dataRoot)},${JSON.stringify(root)}).root()));`], { encoding: 'utf8' });
  expect(JSON.parse(output)).toBe('designs');
  for (const value of ['../outside', path.dirname(root), '.git', 'one.fig']) await rejects(session.selectRoot(value));
  for (const name of ['../escape', 'folder/name', '', '.fig', '..', 'bad\\name']) await rejects(session.newPath(name));
  expect(await session.root()).toBe('designs');
  expect(await session.read()).toBe('one.fig');
});
