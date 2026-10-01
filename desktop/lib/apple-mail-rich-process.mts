import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function mailPasteExecutable(resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath): string {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const runtime = root.endsWith('.asar') && resourcesPath ? path.join(resourcesPath, 'runtime') : path.join(root, 'desktop', 'runtime');
  return path.join(runtime, `${process.platform}-${process.arch}`, 'cheshi-mail');
}
export async function runMailPaste(command: { action: 'check' | 'paste'; title?: string; html?: string; body?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(mailPasteExecutable(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let failed = false;
    const abort = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(abort, 20_000);
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 4096) abort(); });
    child.stderr.resume();
    child.stdin.on('error', abort);
    child.once('error', () => { clearTimeout(timer); reject(new Error('preparation-failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        process.stderr.write(`[cheshi] Mail helper ${failed ? 'timed out or exceeded a transport limit' : 'exited unsuccessfully'}.\n`);
        reject(new Error('preparation-failed')); return;
      }
      try {
        const result = JSON.parse(output);
        if (result.ok === true) resolve();
        else {
          if (['permission', 'request', 'window', 'body', 'focus', 'format', 'clipboard', 'select', 'paste', 'verify'].includes(result.stage)) {
            process.stderr.write(`[cheshi] Mail preparation stopped at ${result.stage}.\n`);
          }
          reject(new Error(result.code === 'accessibility' ? 'accessibility' : 'preparation-failed'));
        }
      } catch { reject(new Error('preparation-failed')); }
    });
    child.stdin.end(JSON.stringify(command));
  });
}
