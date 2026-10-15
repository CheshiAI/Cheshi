import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function speechExecutable(resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  moduleUrl = import.meta.url): string {
  const root = path.resolve(fileURLToPath(new URL('../..', moduleUrl)));
  const runtime = root.endsWith('.asar') && resourcesPath ? path.join(resourcesPath, 'runtime') : path.join(root, 'desktop', 'runtime');
  return path.join(runtime, `${process.platform}-${process.arch}`, 'cheshi-speech');
}
/** Bounded NDJSON; no audio, native diagnostics, or private paths are logged. */
export function runSpeechCommand(command: unknown, onMessage: (value: unknown) => void, signal: AbortSignal,
  options: { executable?: string; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const child = spawn(options.executable ?? speechExecutable(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, failure: Error | undefined;
    const stop = (reason: string) => { failure ??= new Error(reason); child.kill('SIGKILL'); };
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 60 * 60_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16_000_000) { stop('response-too-large'); return; }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { onMessage(JSON.parse(line)); } catch { stop('invalid-response'); return; }
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => stop('helper-unavailable'));
    child.once('error', () => { cleanup(); reject(new Error('helper-unavailable')); });
    child.once('close', code => {
      cleanup();
      if (failure || code !== 0 || buffer.trim()) reject(failure ?? new Error('helper-failed'));
      else resolve();
    });
    child.stdin.end(`${JSON.stringify(command)}\n`);
  });
}
