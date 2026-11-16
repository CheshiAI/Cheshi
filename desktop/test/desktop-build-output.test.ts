import { expect, test } from 'bun:test';
import { mkdtemp, rename, rm, writeFile, readFile, mkdir, readdir, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTimestamp, reserveBuildOutput, discardBuildOutput, recoverAbandonedBuilds, saveBuildOwner } from '../../scripts/desktop-build-output.mts';

test('build timestamps use Korea time with fixed-width chronological names', () => {
  expect(buildTimestamp(new Date('2026-10-15T06:48:17Z'))).toBe('20261015-154817');
  expect(buildTimestamp(new Date('2026-12-31T15:00:00Z'))).toBe('20270101-000000');
});

test('recovery removes dead owned staging but preserves live owners, active children, unknown folders and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-build-recovery-'));
  try {
    const dead = await reserveBuildOutput(root);
    dead.owner.pid = 2_147_483_647;
    await saveBuildOwner(dead);
    await writeFile(join(dead.staging, 'partial'), 'incomplete');
    const live = await reserveBuildOutput(root);
    const child = await reserveBuildOutput(root);
    child.owner.pid = dead.owner.pid;
    child.owner.groups = [process.pid];
    await saveBuildOwner(child);
    const unknown = join(root, '.building-20000101-000000');
    await mkdir(unknown);
    await writeFile(join(unknown, 'keep'), 'unknown owner');
    const link = join(root, '.building-20000101-000001');
    await createSymbolicLink(live.staging, link);
    expect(await recoverAbandonedBuilds(root)).toEqual([dead.staging]);
    expect((await readdir(root)).sort()).toEqual([live.name, child.name].map(name => `.building-${name}`)
      .concat(['.building-20000101-000000', '.building-20000101-000001']).sort());
    expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('unknown owner');
    expect(await recoverAbandonedBuilds(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup rejects a replaced owner and never touches an existing completed build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-build-ownership-'));
  try {
    const build = await reserveBuildOutput(root);
    const replacement = { ...build, owner: { ...build.owner, token: '00000000-0000-0000-0000-000000000000' } };
    await saveBuildOwner(replacement);
    await mkdir(build.destination);
    await writeFile(join(build.destination, 'keep'), 'complete');
    let error: unknown;
    try { await discardBuildOutput(build); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('ownership');
    await discardBuildOutput(replacement);
    expect(await readFile(join(build.destination, 'keep'), 'utf8')).toBe('complete');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent and completed builds never overwrite an existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-build-output-'));
  try {
    const date = new Date('2026-10-15T06:48:17Z');
    const builds = await Promise.all(Array.from({ length: 3 }, () => reserveBuildOutput(root, date)));
    expect(new Set(builds.map(build => build.name)).size).toBe(3);
    for (const build of builds) {
      await writeFile(join(build.staging, 'keep.txt'), build.name);
      await rename(build.staging, build.destination);
    }
    const next = await reserveBuildOutput(root, date);
    expect(builds.some(build => build.destination === next.destination)).toBe(false);
    for (const build of builds) expect(await readFile(join(build.destination, 'keep.txt'), 'utf8')).toBe(build.name);
  } finally { await rm(root, { recursive: true, force: true }); }
});
