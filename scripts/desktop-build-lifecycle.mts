import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildProcessExists, completeBuildOutput, discardBuildOutput, recoverAbandonedBuilds,
  reserveBuildOutput, saveBuildOwner, type BuildOutput } from './desktop-build-output.mts';

export class BuildInterruptedError extends Error {
  readonly exitCode: number;
  constructor(signal: NodeJS.Signals) { super(`Build interrupted (${signal}).`); this.exitCode = signal === 'SIGINT' ? 130 : 143; }
}

async function stopGroup(group: number): Promise<void> {
  if (!buildProcessExists(group)) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { process.kill(group, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!buildProcessExists(group)) return;
      await delay(20);
    }
  }
  throw new Error(`Build process group ${group} did not stop.`);
}

export async function withDesktopBuild<T>(options: {
  out: string;
  cwd: string;
  build(output: BuildOutput, run: (command: string[]) => Promise<void>): Promise<T>;
  onRecovered?: (path: string) => void;
  onDiscarded?: (path: string) => void;
}) {
  for (const path of await recoverAbandonedBuilds(options.out)) options.onRecovered?.(path);
  const output = await reserveBuildOutput(options.out);
  let interrupted: BuildInterruptedError | undefined;
  let active: { child: ChildProcess; group: number } | undefined;
  let stopping: Promise<void> | undefined;
  const assertRunning = () => { if (interrupted) throw interrupted; };
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted ??= new BuildInterruptedError(signal);
    if (active && !stopping) {
      // Close a gate that has not opened yet as well as stopping a running command.
      active.child.stdin?.destroy();
      stopping = stopGroup(active.group);
      void stopping.catch(() => {});
    }
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const run = async (command: string[]) => {
    assertRunning();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./desktop-build-command.mts', import.meta.url)), ...command], {
      cwd: options.cwd, env: { ...process.env, CHESHI_PACKAGE_OUT: output.staging },
      detached: process.platform !== 'win32', stdio: ['pipe', 'inherit', 'inherit'],
    });
    const exit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command.join(' ')} failed (${signal ?? code}).`)));
    });
    void exit.catch(() => {});
    // An interrupted gate can report EPIPE; the process outcome remains authoritative.
    child.stdin?.on('error', () => {});
    if (!child.pid) return await exit;
    const group = process.platform === 'win32' ? child.pid : -child.pid;
    active = { child, group };
    output.owner.groups.push(group);
    try {
      await saveBuildOwner(output);
      assertRunning();
      child.stdin?.end('run\n');
      await exit;
    } finally {
      child.stdin?.destroy();
      if (stopping) await stopping;
      await stopGroup(group);
      active = undefined;
      stopping = undefined;
      output.owner.groups = output.owner.groups.filter(value => value !== group);
      await saveBuildOwner(output);
    }
    assertRunning();
  };
  try {
    const value = await options.build(output, run);
    assertRunning();
    await completeBuildOutput(output);
    return { output, value };
  } catch (error) {
    try {
      if (stopping) await stopping;
      if (active) await stopGroup(active.group);
      await discardBuildOutput(output);
      options.onDiscarded?.(output.staging);
    } catch (cleanupError) {
      throw new AggregateError([interrupted ?? error, cleanupError], `Build failed; cleanup incomplete: ${output.staging}`);
    }
    throw interrupted ?? error;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
