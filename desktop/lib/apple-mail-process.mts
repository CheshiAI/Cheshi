import { spawn } from 'node:child_process';

export class MailProcessError extends Error {
  readonly reason: 'timeout' | 'output' | 'process';
  constructor(reason: MailProcessError['reason']) {
    super(`Mail automation ${reason} failure`);
    this.reason = reason;
  }
}

export function runMailScript(source: string, options: {
  timeoutMs?: number; maxOutputBytes?: number; spawnProcess?: typeof spawn;
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: MailProcessError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    };
    const timer = setTimeout(() => finish(new MailProcessError('timeout')), options.timeoutMs ?? 90_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 8_000_000)) finish(new MailProcessError('output'));
      else chunks.push(chunk);
    });
    // Mail diagnostics may contain private message text.
    child.stderr?.resume();
    child.stdin?.on('error', () => finish(new MailProcessError('process')));
    child.once('error', () => finish(new MailProcessError('process')));
    child.once('close', code => finish(code === 0 ? undefined : new MailProcessError('process')));
    child.stdin?.end(source);
  });
}
