import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { GitHubLoginState } from '../shared/workspace-management.ts';

const DEVICE_URL = 'https://github.com/login/device';
const OUTPUT_LIMIT = 8_192;
const STARTUP_TIMEOUT_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 15 * 60_000;

export type GitHubLoginSpawner = (
  command: string, args: readonly string[], options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface GitHubLoginOptions {
  openExternal: (url: string) => Promise<void>;
  spawn?: GitHubLoginSpawner;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  attemptTimeoutMs?: number;
}

interface LoginAttempt {
  child: ChildProcessWithoutNullStreams;
  output: string;
  startupTimer: ReturnType<typeof setTimeout> | null;
  attemptTimer: ReturnType<typeof setTimeout> | null;
}

function loginEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) =>
      !key.startsWith('GIT_') && !['GH_DEBUG', 'GH_FORCE_TTY', 'GH_PROMPT_DISABLED', 'CLICOLOR_FORCE', 'FORCE_COLOR'].includes(key))),
    NO_COLOR: '1', TERM: 'dumb',
  };
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 2_000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

/** Owns only the CLI process started for this window's interactive sign-in. */
export class GitHubLoginService {
  private readonly options: GitHubLoginOptions;
  private attempt: LoginAttempt | null = null;
  private current: GitHubLoginState = { state: 'idle', userCode: null, error: null };
  private disposed = false;

  constructor(options: GitHubLoginOptions) {
    this.options = options;
  }

  status(): GitHubLoginState {
    return { ...this.current };
  }

  start(): GitHubLoginState {
    if (this.disposed || this.attempt) return this.status();
    const env = loginEnvironment(this.options.env ?? process.env);
    if (env.GH_TOKEN || env.GITHUB_TOKEN) {
      this.current = { state: 'error', userCode: null,
        error: 'GitHub authentication is supplied by an environment token. Remove GH_TOKEN or GITHUB_TOKEN from the app environment to sign in through your browser.' };
      return this.status();
    }
    this.current = { state: 'starting', userCode: null, error: null };
    try {
      const createChild: GitHubLoginSpawner = this.options.spawn ?? ((command, args, options) => spawn(command, args, { ...options, stdio: 'pipe' }));
      const child = createChild('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key'], { env, windowsHide: true });
      const attempt: LoginAttempt = { child, output: '', startupTimer: null, attemptTimer: null };
      this.attempt = attempt;
      child.on('error', (error: NodeJS.ErrnoException) => this.fail(attempt, error.code === 'ENOENT'
        ? 'Install GitHub CLI to sign in through your browser, then try again.' : 'GitHub sign-in could not start. Try again.'));
      child.once('close', (code) => {
        if (this.attempt !== attempt) return;
        if (code !== 0) {
          this.fail(attempt, 'GitHub sign-in did not complete. Try again.');
          return;
        }
        this.release(attempt);
        this.current = { state: 'complete', userCode: null, error: null };
      });
      child.stderr.on('data', (chunk: Buffer | string) => this.readOutput(attempt, chunk));
      child.stdout.resume();
      child.stdin.end();
      attempt.startupTimer = setTimeout(() => this.fail(attempt, 'GitHub did not provide a sign-in code. Check your connection and try again.'),
        this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
      attempt.attemptTimer = setTimeout(() => this.fail(attempt, 'GitHub sign-in expired. Start again to get a new code.'),
        this.options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
      attempt.startupTimer.unref();
      attempt.attemptTimer.unref();
    } catch (error) {
      const attempt = this.attempt;
      if (attempt) {
        this.release(attempt);
        stopChild(attempt.child);
      }
      this.current = { state: 'error', userCode: null, error: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Install GitHub CLI to sign in through your browser, then try again.' : 'GitHub sign-in could not start. Try again.' };
    }
    return this.status();
  }

  async openBrowser(): Promise<void> {
    if (this.current.state !== 'waiting' || !this.attempt) throw new Error('Start GitHub sign-in to get a code first.');
    try {
      await this.options.openExternal(DEVICE_URL);
    } catch {
      throw new Error('The browser could not open. Open https://github.com/login/device and enter the displayed code.');
    }
  }

  cancel(): void {
    const attempt = this.attempt;
    if (attempt) {
      this.release(attempt);
      stopChild(attempt.child);
    }
    this.current = { state: 'idle', userCode: null, error: null };
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private readOutput(attempt: LoginAttempt, chunk: Buffer | string): void {
    if (this.attempt !== attempt || this.current.state !== 'starting') return;
    attempt.output = (attempt.output + chunk.toString()).slice(-OUTPUT_LIMIT);
    const code = /First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9-])/.exec(attempt.output)?.[1]
      ?? /One-time code \(([A-Z0-9]{4}-[A-Z0-9]{4})\) copied to clipboard/.exec(attempt.output)?.[1];
    if (!code) return;
    if (attempt.startupTimer) clearTimeout(attempt.startupTimer);
    attempt.startupTimer = null;
    attempt.output = '';
    this.current = { state: 'waiting', userCode: code, error: null };
  }

  private release(attempt: LoginAttempt): void {
    if (attempt.startupTimer) clearTimeout(attempt.startupTimer);
    if (attempt.attemptTimer) clearTimeout(attempt.attemptTimer);
    attempt.output = '';
    this.attempt = null;
  }

  private fail(attempt: LoginAttempt, error: string): void {
    if (this.attempt !== attempt) return;
    this.release(attempt);
    this.current = { state: 'error', userCode: null, error };
    stopChild(attempt.child);
  }
}
