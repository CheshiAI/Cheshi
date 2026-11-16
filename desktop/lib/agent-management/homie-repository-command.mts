import { execFile } from 'node:child_process';
import { devNull } from 'node:os';

export interface RepositoryCommandResult { code: number; stdout: string; stderr: string }
export type RepositoryCommand = (command: 'git' | 'gh', args: string[], cwd?: string) => Promise<RepositoryCommandResult>;

/** No shell or interactive prompts; credentials stay in gh's credential store. */
export const runRepositoryCommand: RepositoryCommand = (command, args, cwd) => new Promise((resolve, reject) => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'GH_DEBUG')),
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  const arguments_ = command === 'git' ? ['-c', `core.hooksPath=${devNull}`, '-c', 'credential.helper=',
    '-c', 'credential.helper=!gh auth git-credential', ...args] : args;
  execFile(command, arguments_, { cwd, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
    (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) {
        reject(new Error(error.code === 'ENOENT' ? `Install ${command} before creating a Homie.` : 'Homie repository command timed out or could not start. Retry after checking the environment.'));
      } else resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
});

export function repositoryCommandFailure(result: RepositoryCommandResult): Error {
  // Never include command output: it can contain account information or credentials.
  const detail = result.stderr;
  if (/HTTP 401|Bad credentials|gh auth login|not logged|authentication required/i.test(detail)) {
    return new Error('Sign in to GitHub before creating a Homie.');
  }
  if (/HTTP 403|HTTP 429|rate limit|SAML|SSO/i.test(detail)) {
    return new Error('GitHub denied repository access. Check organization permissions, SSO, or rate limits.');
  }
  return new Error('Could not prepare the Homie repository. Check GitHub access and network connectivity, then retry. Existing files were retained.');
}

export async function checkedRepositoryCommand(run: RepositoryCommand, command: 'git' | 'gh', args: string[], cwd?: string): Promise<string> {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw repositoryCommandFailure(result);
  return result.stdout.trim();
}
