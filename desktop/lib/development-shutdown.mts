import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEVELOPMENT_SHUTDOWN_DIRECTORY = 'CHESHI_DEV_SHUTDOWN_DIRECTORY';
const REQUEST_FILE = 'quit';

export function developmentProcessIdentity(pid: number): string {
  return execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8' }).trim();
}

export function signalDevelopmentApp(directory: string, executable: string, signal: 'SIGTERM' | 'SIGKILL',
  inspect = developmentProcessIdentity, kill = process.kill): void {
  const receipt: unknown = JSON.parse(readFileSync(path.join(directory, 'process.json'), 'utf8'));
  if (!receipt || typeof receipt !== 'object' || !('pid' in receipt) || !('identity' in receipt)
    || !Number.isSafeInteger(receipt.pid) || Number(receipt.pid) <= 1
    || typeof receipt.identity !== 'string' || !receipt.identity.endsWith(` ${executable}`)) {
    throw new Error('Cannot identify this development app for forced shutdown. Close its window manually.');
  }
  const pid = Number(receipt.pid);
  // Include the OS process birth time so a reused PID cannot match a stale receipt.
  if (inspect(pid) !== receipt.identity) throw new Error('The development process identity has changed.');
  kill(pid, signal);
}

/** One private control directory per launch, shared only with that app instance. */
export function createDevelopmentShutdownRequest() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cheshi-dev-shutdown-'));
  return {
    directory,
    request: () => writeFileSync(path.join(directory, REQUEST_FILE), ''),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function watchDevelopmentShutdown(directory: string | undefined, quit: () => void): () => void {
  if (!directory || !path.isAbsolute(directory)) return () => {};
  if (process.platform === 'darwin' && process.env.CHESHI_DEV_LAUNCH_SERVICES === '1') {
    writeFileSync(path.join(directory, 'process.json'), JSON.stringify({
      pid: process.pid, identity: developmentProcessIdentity(process.pid),
    }), { mode: 0o600 });
  }
  let requested = false;
  const check = () => {
    if (requested || !existsSync(path.join(directory, REQUEST_FILE))) return;
    requested = true;
    quit();
  };
  const watcher = watch(directory, check);
  // Observe requests sent before Electron finished bootstrapping as well.
  check();
  return () => watcher.close();
}

function completedWithin(completion: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    void completion.then(() => { clearTimeout(timer); resolve(true); });
  });
}

/** Keep cleanup and restart bounded even when Electron or a descendant hangs. */
export async function stopDevelopmentProcess(options: {
  completion: Promise<unknown>;
  requestQuit: () => void;
  signal: (signal: 'SIGTERM' | 'SIGKILL') => void;
  graceMs?: number;
  terminateMs?: number;
  killMs?: number;
}): Promise<void> {
  let finished = false;
  const completion = options.completion.then(() => { finished = true; }, () => { finished = true; });
  await Promise.resolve();
  if (finished) return;
  try { options.requestQuit(); }
  catch { /* Startup may have failed before it installed its shutdown listener. */ }
  if (await completedWithin(completion, options.graceMs ?? 5_000)) return;
  options.signal('SIGTERM');
  if (await completedWithin(completion, options.terminateMs ?? 2_000)) return;
  options.signal('SIGKILL');
  if (await completedWithin(completion, options.killMs ?? 2_000)) return;
  throw new Error('The development process did not exit after forced shutdown.');
}
