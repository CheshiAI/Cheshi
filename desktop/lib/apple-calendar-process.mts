import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function calendarExecutable(resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath): string {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const runtime = root.endsWith('.asar') && resourcesPath ? path.join(resourcesPath, 'runtime') : path.join(root, 'desktop', 'runtime');
  return path.join(runtime, `${process.platform}-${process.arch}`, 'cheshi-calendar');
}

export function runCalendarCommand(command: unknown, options: {
  executable?: string; timeoutMs?: number; spawnProcess?: typeof spawn;
} = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(options.executable ?? calendarExecutable(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const abort = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(abort, options.timeoutMs ?? 90_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8_000_000) abort();
      else chunks.push(chunk);
    });
    // Native diagnostics can contain calendar data. Never forward them to logs.
    child.stderr?.resume();
    child.stdin?.on('error', abort);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Calendar helper unavailable')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(new Error('Calendar helper failed')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid calendar response')); }
    });
    child.stdin?.end(JSON.stringify(command));
  });
}
