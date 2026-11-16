import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHostDependencyLock } from '../shared/host-dependencies';
import { HostServiceDependencies } from '../lib/agent-management/host-service-dependencies.mts';

export const dependencyLockFixture = JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { example: '1.0.0' } },
  'node_modules/example': { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: `sha512-${'a'.repeat(86)}==` },
} });
async function fails(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}
test('dependency locks reject unpinned, local, credentialed and escaping packages', () => {
  expect(parseHostDependencyLock(dependencyLockFixture).dependencies).toEqual({ example: '1.0.0' });
  for (const patch of [{ resolved: 'file:/tmp/pkg' }, { resolved: 'https://secret@registry.npmjs.org/pkg.tgz' }, { integrity: undefined }, { link: true }]) {
    const lock = JSON.parse(dependencyLockFixture);
    Object.assign(lock.packages['node_modules/example'], patch);
    expect(() => parseHostDependencyLock(JSON.stringify(lock))).toThrow();
  }
  const lock = JSON.parse(dependencyLockFixture);
  lock.packages[''].dependencies.example = '^1.0.0';
  expect(() => parseHostDependencyLock(JSON.stringify(lock))).toThrow('exact');
  lock.packages[''].dependencies.example = '1.0.0';
  lock.packages['node_modules/example/node_modules/bundled'] = { inBundle: true, version: '1.0.0' };
  expect(parseHostDependencyLock(JSON.stringify(lock)).dependencies.example).toBe('1.0.0');
  lock.packages['node_modules/orphan'] = { inBundle: true };
  expect(() => parseHostDependencyLock(JSON.stringify(lock))).toThrow('parent');
});

test('failed preparation cleans staging; retry publishes verified packages and cached use runs no installer', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-dependencies-')));
  const npm = join(root, 'npm.cjs'), executable = await realpath(process.execPath);
  const node = { prepare: async () => ({ executable, npm, id: 'fixture-node' }) };
  const manager = new HostServiceDependencies(join(root, 'runtime'), node);
  const progress: string[] = [];
  const prepare = () => manager.prepare(dependencyLockFixture, AbortSignal.timeout(20_000), text => progress.push(text));
  try {
    await writeFile(npm, 'process.exit(1)');
    await fails(prepare(), 'installation failed');
    expect(await readdir(join(root, 'runtime/packages'))).toEqual([]);
    await writeFile(npm, `const fs=require('node:fs');
if(!process.argv.includes('--ignore-scripts') || !process.argv.includes('ci') || process.env.npm_config_cache===undefined) process.exit(2);
fs.mkdirSync('node_modules/example',{recursive:true});fs.writeFileSync('node_modules/example/index.js','verified');`);
    const prepared = await prepare();
    expect(await manager.check(dependencyLockFixture, prepared)).toBe(true);
    await writeFile(npm, 'process.exit(9)');
    expect(await prepare()).toEqual(prepared);
    expect(progress).toContain('Downloading and installing declared dependencies…');
    await writeFile(join(prepared.directory, 'node_modules/example/index.js'), 'corrupt');
    expect(await manager.check(dependencyLockFixture, prepared)).toBe(false);
    await fails(prepare(), 'damaged');
    expect(await manager.check(dependencyLockFixture, { ...prepared, directory: root })).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('canceled preparation cannot publish a partial installation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-dependencies-cancel-')));
  const npm = join(root, 'npm.cjs');
  await writeFile(npm, 'setTimeout(()=>{},30000)');
  const manager = new HostServiceDependencies(join(root, 'runtime'), {
    prepare: async () => ({ executable: await realpath(process.execPath), npm, id: 'fixture' }),
  });
  try {
    const abort = new AbortController();
    const pending = manager.prepare(dependencyLockFixture, abort.signal, message => {
      if (message.includes('Downloading')) setTimeout(() => abort.abort(new Error('Canceled fixture')), 50);
    });
    await fails(pending, 'Canceled fixture');
    expect(await readdir(join(root, 'runtime/packages'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
