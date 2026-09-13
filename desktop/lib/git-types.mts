export interface CommandOptions {
  cwd: string;
  acceptedExitCodes?: number[];
  maxBytes?: number;
  timeout?: number;
}

export interface GitRepositoryWatchOptions {
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export interface GitCommandOptions {
  acceptedExitCodes?: number[];
  maxBytes?: number;
  timeout?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

export type JsonObject = Record<string, unknown>;

export interface GitCommandErrorDetails {
  command?: string | null;
  exitCode?: number | null;
  stderr?: string;
}

export interface GitFileChange {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitBranch {
  name: string;
  fullName: string;
  hash: string;
  upstream: string | null;
  upstreamRemote: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  remote: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  decorations: string;
  subject: string;
}

export type GitSnapshot =
  | { available: false; message: string }
  | {
      available: true;
      message: string;
      head: string | null;
      detached: boolean;
      upstream: string | null;
      upstreamPublished: boolean;
      ahead: number;
      behind: number;
      pullRequestBase: string | null;
      pullRequestAhead: number | null;
      changes: GitFileChange[];
      branches: GitBranch[];
      commits: GitCommit[];
    };
