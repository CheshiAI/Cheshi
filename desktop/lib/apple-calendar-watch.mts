import { spawn } from 'node:child_process';
import { calendarExecutable } from './apple-calendar-process.mts';

type Timer = (callback: () => void, delay: number) => () => void;
const timer: Timer = (callback, delay) => {
  const handle = setTimeout(callback, delay); handle.unref?.(); return () => clearTimeout(handle);
};

/** One idle native observer; retries only after a transport failure, with a limit. */
export function watchAppleCalendar(options: {
  changed(): void; clockChanged(): void; error(message: string): void;
  spawnProcess?: typeof spawn; executable?: string; schedule?: Timer;
}) {
  const schedule = options.schedule ?? timer;
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  let retries = 0;
  let cancelRetry: (() => void) | undefined;
  let cancelStartup: (() => void) | undefined;
  let closed: Promise<void> = Promise.resolve();
  const start = () => {
    if (stopped) return;
    let process: ReturnType<typeof spawn>;
    try { process = (options.spawnProcess ?? spawn)(options.executable ?? calendarExecutable(), ['--watch'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reconnect(); return; }
    child = process;
    let buffer = '';
    let ready = false;
    let failed = false;
    const fail = () => { if (!failed) { failed = true; process.kill('SIGKILL'); } };
    cancelStartup = schedule(fail, 10_000);
    // No native calendar content or diagnostics are sent to logs/the renderer.
    process.stderr?.resume();
    process.stdin?.on('error', fail);
    process.once('error', () => { failed = true; });
    process.stdout?.setEncoding('utf8');
    process.stdout?.on('data', (chunk: string) => {
      if (stopped || failed) return;
      buffer += chunk;
      if (buffer.length > 4096) { fail(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const event = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (event === 'ready' && !ready) {
          ready = true; cancelStartup?.(); cancelStartup = undefined; options.error(''); options.changed();
        } else if (ready && event === 'changed') options.changed();
        else if (ready && event === 'clock-changed') options.clockChanged();
        else { fail(); return; }
      }
    });
    closed = new Promise(resolve => process.once('close', () => {
      cancelStartup?.(); cancelStartup = undefined; child = undefined; resolve();
      if (!stopped) reconnect();
    }));
  };
  const reconnect = () => {
    options.error('Calendar change monitoring disconnected.');
    if (stopped || retries >= 5) return;
    cancelRetry = schedule(start, Math.min(30_000, 1000 * 2 ** retries++));
  };
  start();
  return { async stop() {
    stopped = true; cancelRetry?.(); cancelStartup?.();
    const current = child;
    if (!current) return;
    current.stdin?.end();
    const force = schedule(() => current.kill('SIGKILL'), 2000);
    await closed; force();
  } };
}
