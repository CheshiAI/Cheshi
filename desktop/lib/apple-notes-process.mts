import { spawn } from 'node:child_process';

export class AppleNotesProcessError extends Error {
  readonly reason: 'timeout' | 'output' | 'process';
  constructor(reason: AppleNotesProcessError['reason']) {
    super(`Apple Notes automation ${reason} failure.`);
    this.reason = reason;
  }
}

export interface AppleNotesProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: typeof spawn;
}

export function runAppleNotesScript(source: string, options: AppleNotesProcessOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)('/usr/bin/osascript', ['-l', 'JavaScript', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: AppleNotesProcessError | null = null;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const abort = (reason: AppleNotesProcessError['reason']) => {
      failure ??= new AppleNotesProcessError(reason);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => abort('timeout'), options.timeoutMs ?? 45_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 4_000_000)) abort('output');
      else chunks.push(chunk);
    });
    // Do not expose JXA diagnostics: they can contain private note contents.
    child.stderr?.resume();
    child.once('error', () => { clearTimeout(timer); reject(new AppleNotesProcessError('process')); });
    child.stdin?.on('error', () => abort('process'));
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new AppleNotesProcessError('process'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin?.end(source);
  });
}
