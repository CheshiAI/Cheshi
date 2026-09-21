import type { ChildProcess } from 'node:child_process';

/** Parent watchdog also works when imported skill code blocks the child's event loop. */
export function superviseSkillProcess(child: ChildProcess, options: {
  timeoutMs: number;
  graceMs?: number;
  onForcedStop?(): void;
}) {
  const graceMs = options.graceMs ?? 5000;
  let stopped = false;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const forceStop = () => {
    if (stopped) return;
    child.kill('SIGKILL');
    options.onForcedStop?.();
  };
  const deadline = setTimeout(forceStop, options.timeoutMs + graceMs);
  const completed = new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      stopped = true;
      clearTimeout(deadline);
      clearTimeout(cancellationTimer);
      child.removeListener('error', failed);
      child.removeListener('exit', exited);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = (code: number | null) => { cleanup(); resolve(code ?? 1); };
    child.once('error', failed);
    child.once('exit', exited);
  });
  return { completed, interrupt() {
    if (stopped) return;
    child.kill('SIGTERM');
    cancellationTimer ??= setTimeout(forceStop, graceMs);
  } };
}
