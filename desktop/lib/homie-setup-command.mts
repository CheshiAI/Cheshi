import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { desktopToolPath } from './workspace-tool-status.mts';

export function findSetupTool(name: 'brew' | 'docker' | 'colima'): string | null {
  for (const directory of desktopToolPath(process.env.PATH).split(':').filter(isAbsolute)) {
    const file = join(directory, name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}
export interface SetupCommandOptions {
  signal: AbortSignal;
  timeout: number;
  env: NodeJS.ProcessEnv;
  output?: (text: string) => void;
  input?: string;
}
export type SetupCommand = (file: string, args: string[], options: SetupCommandOptions) => Promise<string>;
export class SetupCommandError extends Error {}
export const runSetupCommand: SetupCommand = (file, args, options) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { signal: options.signal, timeout: options.timeout,
    env: options.env, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    let reason = 'Command failed. Check the Homebrew or Colima installation and retry.';
    if (error.code === 'ENOENT') reason = 'Required executable was not found. Check installation and retry.';
    else if (error.code === 'EACCES' || error.code === 'EPERM' || /permission denied|not writable/i.test(stderr)) reason = 'Permission denied. Check permissions for Homebrew and Colima, then retry.';
    else if (options.signal.aborted || error.killed) reason = 'Operation stopped or timed out. Check its status before retrying.';
    else if (/context.*not found|cannot connect to the docker daemon|failed to connect to the docker API/i.test(stderr)) reason = 'Colima is stopped or its Docker connection is missing. Start Colima and check again.';
    else if (/could not resolve|failed to download|connection refused|network is unreachable/i.test(stderr)) reason = 'Download or connection failed. Check network access and retry.';
    else if (/command line tools|xcode/i.test(stderr)) reason = 'Apple Command Line Tools need attention. Complete their installation and retry.';
    else if (/no space left/i.test(stderr)) reason = 'Not enough disk space. Free space and retry.';
    reject(new SetupCommandError(reason));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8'); stream?.on('data', (text: string) => options.output?.(text));
  }
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.input);
});
