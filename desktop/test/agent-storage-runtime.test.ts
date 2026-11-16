import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_TMPFS_BYTES } from '../../experiments/codex-specialists/src/task-storage-limits.ts';
import { TaskOutput } from '../../experiments/codex-specialists/src/task-output.ts';
import forgeConfig from '../../forge.config.mts';

test('packaged desktop includes the shared runtime storage limits', async () => {
  const ignore = (await forgeConfig()).packagerConfig?.ignore;
  if (typeof ignore !== 'function') throw new Error('Expected packaging file filter');
  expect(ignore('/experiments/codex-specialists/src/task-storage-limits.ts')).toBe(false);
});

test('larger scratch does not increase the 1 GiB output limit or replace the last good snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'cheshi-output-limit-'));
  try {
    const output = new TaskOutput(root, join(root, 'archive'));
    writeFileSync(join(output.directory, 'report.md'), 'saved evidence');
    output.preserve();
    const pointer = join(root, 'archive', 'latest.json'), previous = readFileSync(pointer, 'utf8');
    const descriptor = openSync(join(output.directory, 'oversized.bin'), 'wx');
    try { ftruncateSync(descriptor, 1024 * 1024 * 1024 + 1); }
    finally { closeSync(descriptor); }
    expect(() => output.preserve()).toThrow('exceeds 1 GiB');
    expect(readFileSync(pointer, 'utf8')).toBe(previous);
    const snapshot = JSON.parse(previous) as { snapshot: string };
    expect(readFileSync(join(root, 'archive', snapshot.snapshot, 'report.md'), 'utf8')).toBe('saved evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function runStorageDocker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Storage fixture Docker failed (${exitCode}): ${stderr}`);
  return stdout;
}

const context = process.env.CHESHI_STORAGE_DOCKER_CONTEXT;
const image = process.env.CHESHI_STORAGE_DOCKER_IMAGE ?? 'cheshi-specialist:1-codex-0.163.0';
const source = fileURLToPath(new URL('../../experiments/codex-specialists/src/', import.meta.url));
const probe = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, statfsSync } from 'node:fs';
import { TaskOutput } from '/runtime/task-output.ts';
import { TaskScratch } from '/runtime/task-scratch.ts';
const chunk = Buffer.alloc(16 * 1024 * 1024, 73);
const digest = b => createHash('sha256').update(b).digest('hex');
const expected = digest(chunk);
if (process.env.PROBE_PHASE === 'seed') {
  mkdirSync('/agent/seed');
  const output = new TaskOutput('/agent/seed', '/agent/archive');
  for (let i = 0; i < 9; i++) writeFileSync(output.directory + '/' + i + '.bin', chunk);
  output.preserve();
  console.log(JSON.stringify({ seededBytes: chunk.length * 9 }));
} else {
  try {
    const first = new TaskScratch('/tmp', '/agent/archive');
    assert.equal(readdirSync(first.output.directory).length, 9);
    for (let i = 0; i < 9; i++) assert.equal(digest(readFileSync(first.output.directory + '/' + i + '.bin')), expected);
    writeFileSync(first.output.directory + '/new-capture.bin', chunk);
    writeFileSync(first.directory + '/temporary.bin', chunk);
    first.dispose();
    const resumed = new TaskScratch('/tmp', '/agent/archive');
    assert.equal(readdirSync(resumed.output.directory).length, 10);
    assert.equal(digest(readFileSync(resumed.output.directory + '/new-capture.bin')), expected);
    assert.equal(readdirSync(resumed.directory).includes('temporary.bin'), false);
    for (let i = 0; i < 9; i++) assert.equal(digest(readFileSync(resumed.output.directory + '/' + i + '.bin')), expected);
    resumed.dispose();
    const fs = statfsSync('/tmp');
    console.log(JSON.stringify({ restored: true, tmpfsBytes: fs.blocks * fs.bsize, preservedBytes: chunk.length * 10 }));
  } catch (error) {
    if (process.env.PROBE_PHASE !== 'legacy' || error.code !== 'ENOSPC') throw error;
    console.log(JSON.stringify({ restored: false, code: error.code }));
  }
}
`;

test.if(Boolean(context))('real Docker restores more than 128 MiB, saves new captures and resumes them intact', async () => {
  const volume = `cheshi-storage-test-${randomUUID()}`;
  const prefix = ['--context', context!];
  await runStorageDocker([...prefix, 'volume', 'create', volume]);
  const run = async (phase: string, size: number) => JSON.parse(await runStorageDocker([...prefix, 'run', '--rm', '--pull', 'never',
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '2g', '--user', '1000:1000', '--tmpfs', `/tmp:rw,nosuid,nodev,size=${size},mode=1777`,
    '--mount', `type=volume,src=${volume},dst=/agent`, '--mount', `type=bind,src=${source},dst=/runtime,readonly`,
    '--env', `PROBE_PHASE=${phase}`, '--entrypoint', 'bun', image, '-e', probe])) as Record<string, unknown>;
  try {
    expect(await run('seed', 128 * 1024 * 1024)).toEqual({ seededBytes: 144 * 1024 * 1024 });
    expect(await run('legacy', 128 * 1024 * 1024)).toEqual({ restored: false, code: 'ENOSPC' });
    expect(await run('current', WORKER_TMPFS_BYTES)).toEqual({ restored: true,
      tmpfsBytes: WORKER_TMPFS_BYTES, preservedBytes: 160 * 1024 * 1024 });
  } finally { await runStorageDocker([...prefix, 'volume', 'rm', volume]); }
}, 120_000);
