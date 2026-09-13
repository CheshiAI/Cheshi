import type { CommandOptions, CommandResult, GitCommandErrorDetails } from "./git-types.mts";
import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT = 30_000;

export class GitCommandError extends Error {
  stderr: string;
  exitCode: number | null;
  command: string | null;
  constructor(message: string, details: GitCommandErrorDetails = {}) {
    super(message);
    this.name = "GitCommandError";
    this.command = details.command ?? null;
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? "";
  }
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
    acceptedExitCodes = [0],
    maxBytes = DEFAULT_OUTPUT_LIMIT,
    timeout = DEFAULT_TIMEOUT,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new GitCommandError(`Command timed out after ${timeout} ms.`, {
          command: commandDescription(executable, args),
        }),
      );
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) =>
      appendOutput(stdoutChunks, chunk, stdoutState, maxBytes),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      appendOutput(stderrChunks, chunk, stderrState, maxBytes),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new GitCommandError(error.message, {
          command: commandDescription(executable, args),
        }),
      );
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (!acceptedExitCodes.includes(exitCode ?? -1)) {
        reject(
          new GitCommandError(
            stderr.trim() ||
              `Command exited with code ${exitCode ?? "unknown"}.`,
            {
              command: commandDescription(executable, args),
              exitCode,
              stderr,
            },
          ),
        );
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        truncated: stdoutState.truncated || stderrState.truncated,
      });
    });
  });
}
