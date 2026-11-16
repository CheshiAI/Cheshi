import type { CommandOptions, CommandResult, GitCommandErrorDetails } from "./git-types.mts";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT = 30_000;

export class GitCommandError extends Error {
  stderr: string;
  exitCode: number | null;
  command: string | null;
  stdout: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  terminationConfirmed: boolean | null;
  constructor(message: string, details: GitCommandErrorDetails = {}) {
    super(message);
    this.name = "GitCommandError";
    this.command = details.command ?? null;
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? "";
    this.stdout = details.stdout ?? "";
    this.signal = details.signal ?? null;
    this.timedOut = details.timedOut === true;
    this.truncated = details.truncated === true;
    this.terminationConfirmed = details.terminationConfirmed ?? null;
  }
}

function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** A private POSIX group includes Git's SSH/credential helpers, even after Git exits. */
async function terminateCommand(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return true;
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      const deadline = setTimeout(() => { killer.kill(); resolve(false); }, 2_000);
      killer.once('error', () => { clearTimeout(deadline); child.kill('SIGKILL'); resolve(false); });
      killer.once('close', code => { clearTimeout(deadline); resolve(code === 0); });
    });
  }
  for (const [signal, waitMs] of [['SIGTERM', 500], ['SIGKILL', 1_500]] as const) {
    if (!processGroupExists(child.pid)) return true;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!processGroupExists(child.pid)) return true;
      await delay(20);
    }
  }
  return !processGroupExists(child.pid);
}

function commandDescription(executable: string, args: string[]) {
  return [executable, ...args].join(" ");
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  maxBytes: number,
) {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maxBytes - state.bytes;
  const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(next);
  state.bytes += next.length;
  if (next.length < chunk.length) state.truncated = true;
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {CommandOptions} options
 * @returns {Promise<CommandResult>}
 */
export function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const {
    cwd,
    input,
    acceptedExitCodes = [0],
    maxBytes = DEFAULT_OUTPUT_LIMIT,
    timeout = DEFAULT_TIMEOUT,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        NO_COLOR: "1",
      },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let closed = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let resolveClosed!: () => void;
    const close = new Promise<void>(resolve => { resolveClosed = resolve; });
    const details = (): GitCommandErrorDetails => ({
      command: commandDescription(executable, args), exitCode, signal,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      truncated: stdoutState.truncated || stderrState.truncated, timedOut,
    });
    const fail = (message: string, terminationConfirmed: boolean | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitCommandError(message, { ...details(), terminationConfirmed }));
    };
    const onTimeout = async () => {
      timedOut = true;
      const terminated = await terminateCommand(child);
      // Allow final output and the close event to drain after process termination.
      if (!closed) await Promise.race([close, delay(250)]);
      const confirmed = terminated && closed;
      fail(`Command timed out after ${timeout} ms.${confirmed ? '' : ' Process termination could not be confirmed.'}`, confirmed);
      if (!closed) {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      }
    };
    const timer = setTimeout(() => { void onTimeout().catch(error => {
      fail(`Command timed out after ${timeout} ms. Cleanup failed: ${String(error)}`, false);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }); }, timeout);

    // A command can exit before consuming stdin (for example, an untracked blame path).
    // Consume EPIPE; the process exit status remains the authoritative error.
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.stdout!.on("data", (chunk: Buffer) =>
      appendOutput(stdoutChunks, chunk, stdoutState, maxBytes),
    );
    child.stderr!.on("data", (chunk: Buffer) =>
      appendOutput(stderrChunks, chunk, stderrState, maxBytes),
    );
    child.once("error", (error) => {
      if (!timedOut) fail(error.message);
    });
    child.once("close", (code, exitSignal) => {
      closed = true;
      exitCode = code;
      signal = exitSignal;
      resolveClosed();
      clearTimeout(timer);
      if (settled || timedOut) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (!acceptedExitCodes.includes(exitCode ?? -1)) {
        fail(stderr.trim() || `Command exited with code ${exitCode ?? "unknown"}.`);
        return;
      }
      settled = true;
      resolve({
        stdout,
        stderr,
        exitCode,
        truncated: stdoutState.truncated || stderrState.truncated,
      });
    });
  });
}
