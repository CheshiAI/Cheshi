import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import { forwardDesktopDevOutput } from './forward-desktop-dev-output.mts';
import { signalDevelopmentApp } from '../desktop/lib/development-shutdown.mts';

function forwardLog(file: string, target: Writable) {
  writeFileSync(file, '', { mode: 0o600 });
  const descriptor = openSync(file, 'r');
  const stream = new PassThrough();
  forwardDesktopDevOutput(stream, target);
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  const drain = () => {
    const size = fstatSync(descriptor).size;
    while (offset < size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) break;
      stream.write(Buffer.from(buffer.subarray(0, count)));
      offset += count;
    }
  };
  const timer = setInterval(drain, 50);
  return () => {
    clearInterval(timer);
    try { drain(); } finally { closeSync(descriptor); stream.end(); }
  };
}

export function launchDevelopmentApp(options: {
  bundle: string; root: string; directory: string; env: NodeJS.ProcessEnv;
  stdout?: Writable; stderr?: Writable;
}, spawnProcess = spawn) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const output = path.join(options.directory, 'stdout.log');
  const errors = path.join(options.directory, 'stderr.log');
  const stopOutput = forwardLog(output, stdout);
  const stopErrors = forwardLog(errors, stderr);
  const env: NodeJS.ProcessEnv = { ...options.env, CHESHI_DEV_LAUNCH_SERVICES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Launch Services owns the app's TCC responsibility. Environment inheritance
  // avoids exposing credentials through open's command-line --env arguments.
  const child = spawnProcess('/usr/bin/open', ['-n', '-W', '-a', options.bundle,
    '--stdout', output, '--stderr', errors, '--args', options.root], {
    cwd: options.root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  forwardDesktopDevOutput(child.stdout, stdout);
  forwardDesktopDevOutput(child.stderr, stderr);
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => { stopOutput(); stopErrors(); });
  return {
    child, completion,
    signal: (signal: 'SIGTERM' | 'SIGKILL') => signalDevelopmentApp(options.directory,
      path.join(options.bundle, 'Contents', 'MacOS', 'Electron'), signal),
  };
}
