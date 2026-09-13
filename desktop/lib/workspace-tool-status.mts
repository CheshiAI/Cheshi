import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceToolStatus } from '../shared/workspace-management.ts';

/** Finder does not inherit the PATH configured by an interactive shell. */
export function desktopToolPath(value: string | undefined, platform: string = process.platform): string {
  const separator = platform === 'win32' ? ';' : ':';
  const directories = (value ?? '').split(separator).filter(Boolean);
  if (platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  return [...new Set(directories)].join(separator);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch { return false; }
}

interface ToolStatusOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  executable?: (file: string) => boolean;
  homeDirectory?: string;
}

function hasOhMyZsh(env: NodeJS.ProcessEnv, homeDirectory: string): boolean {
  const configured = env.ZSH?.trim();
  const directories = [path.join(homeDirectory, '.oh-my-zsh')];
  if (configured && path.isAbsolute(configured)) directories.unshift(configured);
  return directories.some((directory) => {
    try {
      const entrypoint = path.join(directory, 'oh-my-zsh.sh');
      accessSync(entrypoint, constants.R_OK);
      return statSync(entrypoint).isFile();
    } catch { return false; }
  });
}

/** Inspect installed files only; never start a CLI, read credentials, or run a shell. */
export function getWorkspaceToolStatus(options: ToolStatusOptions = {}): WorkspaceToolStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? isExecutable;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const directories = desktopToolPath(env.PATH, platform).split(paths.delimiter).filter((directory) => paths.isAbsolute(directory));
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const available = (command: string): boolean => {
    const candidates = extensions.includes('') ? [command] : [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
    if (paths.isAbsolute(command)) return candidates.some(executable);
    if (command.includes('/') || command.includes('\\')) return false;
    return directories.some((directory) => candidates.some((candidate) => executable(paths.join(directory, candidate))));
  };
  return {
    platform,
    brew: available('brew'),
    gh: available('gh'),
    codex: available(env.CHESHI_CODEX?.trim() || 'codex'),
    ohMyZsh: platform === 'darwin' && hasOhMyZsh(env, options.homeDirectory ?? os.homedir()),
  };
}
