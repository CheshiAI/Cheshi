import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEVELOPMENT_SHUTDOWN_DIRECTORY = 'CHESHI_DEV_SHUTDOWN_DIRECTORY';
const REQUEST_FILE = 'quit';

/** One private control directory per launch; no PID discovery or shared app identity. */
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
