import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDesktopBuild } from '../../scripts/desktop-build-lifecycle.mts';
import { recoverAbandonedBuilds } from '../../scripts/desktop-build-output.mts';

const lifecycle = new URL('../../scripts/desktop-build-lifecycle.mts', import.meta.url).href;

test('command and verification failures remove partial output while successful builds remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-build-lifecycle-'));
  try {
    const success = await withDesktopBuild({ out: root, cwd: root, build: async (output, run) => {
      await run([process.execPath, '-e', "process.exit(0)"]);
      await writeFile(join(output.staging, 'app'), 'verified');
      return 'app';
    } });
    expect(await readdir(success.output.destination)).toEqual(['app']);
    for (const stage of ['command', 'verification']) {
      let error: unknown;
      let discarded = '';
      try {
        await withDesktopBuild({ out: root, cwd: root, onDiscarded: path => { discarded = path; }, build: async (output, run) => {
          await writeFile(join(output.staging, 'partial'), stage);
          await run([process.execPath, '-e', `process.exit(${stage === 'command' ? 7 : 0})`]);
          throw new Error('Verification failed.');
        } });
      } catch (caught) { error = caught; }
      expect(String(error)).toContain(stage === 'command' ? 'failed (7)' : 'Verification failed');
      expect(discarded).toContain('.building-');
      expect(await readdir(root)).toEqual([success.output.name]);
    }
    expect(await readFile(join(success.output.destination, 'app'), 'utf8')).toBe('verified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

function interruptibleBuild(root: string, mode: 'command' | 'idle') {
  const task = mode === 'command'
    ? `await run([process.execPath, '-e', ${JSON.stringify("const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('ready'); setInterval(() => {}, 1000);")}]);`
    : "console.log('ready'); await new Promise(resolve => setTimeout(resolve, 10000));";
  const code = `import { withDesktopBuild, BuildInterruptedError } from ${JSON.stringify(lifecycle)};
    import { writeFile } from 'node:fs/promises';
    try {
      await withDesktopBuild({ out: ${JSON.stringify(root)}, cwd: ${JSON.stringify(root)}, build: async (output, run) => {
        await writeFile(output.staging + '/partial', 'incomplete'); ${task}
      } });
    } catch (error) { console.error(String(error)); process.exitCode = error instanceof BuildInterruptedError ? error.exitCode : 1; }`;
  const child = spawn(process.execPath, ['--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = createDeferred<void>();
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready')) ready.resolve(); });
  child.stderr.on('data', chunk => { error += String(chunk); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', failure => { ready.reject(failure); reject(failure); });
    child.once('exit', code => { if (!output.includes('ready')) ready.reject(new Error(error)); resolve(code); });
  });
  return { child, ready: ready.promise, exit, error: () => error };
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} stops the command tree before removing its staging directory`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheshi-build-signal-'));
    const fixture = interruptibleBuild(root, 'command');
    try {
      await fixture.ready;
      fixture.child.kill(signal);
      expect(await fixture.exit).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(fixture.error()).toContain('Build interrupted');
      expect(await readdir(root)).toEqual([]);
    } finally { fixture.child.kill('SIGKILL'); await fixture.exit; await rm(root, { recursive: true, force: true }); }
  });
}

test('a killed build owner is recovered on the next invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-build-killed-'));
  const fixture = interruptibleBuild(root, 'idle');
  try {
    await fixture.ready;
    fixture.child.kill('SIGKILL');
    await fixture.exit;
    expect((await readdir(root)).filter(name => name.startsWith('.building-'))).toHaveLength(1);
    expect(await recoverAbandonedBuilds(root)).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  } finally { fixture.child.kill('SIGKILL'); await fixture.exit; await rm(root, { recursive: true, force: true }); }
});
