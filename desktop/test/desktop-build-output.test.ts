import { expect, test } from 'bun:test';
import { mkdtemp, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTimestamp, reserveBuildOutput } from '../../scripts/desktop-build-output.mts';

test('build timestamps use Korea time with fixed-width chronological names', () => {
  expect(buildTimestamp(new Date('2026-10-15T06:48:17Z'))).toBe('20261015-154817');
  expect(buildTimestamp(new Date('2026-12-31T15:00:00Z'))).toBe('20270101-000000');
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
