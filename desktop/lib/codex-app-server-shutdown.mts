import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface CodexShutdownTimeouts {
  gracefulMs: number;
  forceMs: number;
}

export const DEFAULT_CODEX_SHUTDOWN_TIMEOUTS: Readonly<CodexShutdownTimeouts> = {
  gracefulMs: 5000,
  forceMs: 2000,
};

/** Signal only this client's owned child; never a shared process group. */
export function shutdownCodexAppServer(
  child: ChildProcessWithoutNullStreams,
  timeouts: Readonly<CodexShutdownTimeouts>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) {
        // Do not let an unresponsive child or its pipes keep application shutdown hanging.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(error);
      } else resolve();
    };
    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const signal = (value: NodeJS.Signals): void => {
      try { child.kill(value); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => {
      timer = setTimeout(() => {
        finish(new Error(`Codex App Server did not exit after SIGKILL (${timeouts.forceMs}ms).`));
      }, timeouts.forceMs);
      signal('SIGKILL');
    }, timeouts.gracefulMs);
    try { child.stdin.end(); }
    catch { /* A closed input pipe does not prove that the process exited. */ }
    if (!settled) signal('SIGTERM');
  });
}
