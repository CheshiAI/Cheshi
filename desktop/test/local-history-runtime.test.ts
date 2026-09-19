import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLocalHistory } from '../lib/local-history-runtime.mts';
import createForgeConfiguration from '../../forge.config.mts';

test('shares file history across windows and serializes reopening after the last release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cheshi-history-windows-'));
  const options = { workspaceRoot: root, directory: path.join(root, 'history') };
  const first = acquireLocalHistory(options);
  const second = acquireLocalHistory(options);
  let reopened: ReturnType<typeof acquireLocalHistory> | undefined;
  try {
    await writeFile(path.join(root, 'notes.txt'), 'original');
    const initial = await first.readFile('notes.txt');
    const [saved, stale] = await Promise.all([
      first.writeFile({ path: 'notes.txt', content: 'saved', expectedRevision: initial.file.revision }),
      second.writeFile({ path: 'notes.txt', content: 'stale', expectedRevision: initial.file.revision }),
    ]);
    expect(saved.status).toBe('written');
    expect(stale.status).toBe('conflict');
    await first.dispose();
    expect((await second.readFile('notes.txt')).content).toBe('saved');
    const release = second.dispose();
    reopened = acquireLocalHistory(options);
    const entries = await reopened.list('notes.txt');
    expect(entries).toHaveLength(2);
    expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('saved');
    await release;
  } finally {
    await first.dispose();
    await second.dispose();
    await reopened?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('packages local history modules and loads their transitive imports in native strip-only Node', async () => {
  const ignore = (await createForgeConfiguration()).packagerConfig?.ignore;
  if (typeof ignore !== 'function') throw new Error('Expected the packaging allowlist.');
  for (const name of ['store', 'service', 'ipc', 'runtime', 'lock']) {
    expect(ignore(`/desktop/lib/local-history-${name}.mts`)).toBe(false);
  }
  expect(ignore('/desktop/shared/local-history.ts')).toBe(false);
  const modules = ['local-history-runtime.mts', 'local-history-ipc.mts'].map(name =>
    new URL(`../lib/${name}`, import.meta.url).href);
  const result = spawnSync('node', ['--input-type=module', '-e',
    `for (const url of ${JSON.stringify(modules)}) await import(url);`], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
