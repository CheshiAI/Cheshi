import { GitCommandError } from "./git-command.mts";
import { pullRequestCommitId } from "./github-pull-request-data.mts";
import type { CommandOptions, CommandResult, GitCommandOptions } from "./git-types.mts";

const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const FILES_PER_PAGE = 100;
const MAX_API_FILES = 3000;

interface DiffContext {
  runGit(args: string[], options?: GitCommandOptions): Promise<CommandResult>;
  runGitHub(args: string[], options?: Omit<CommandOptions, "cwd">): Promise<CommandResult>;
}

interface PullRequestRevision {
  base: string;
  head: string;
  files: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(result: CommandResult): unknown {
  if (result.truncated) {
    throw new GitCommandError("GitHub's pull request file response exceeded the size limit.");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GitCommandError("GitHub returned an invalid pull request file response.");
  }
}

function isOversizedDiff(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  const message = `${error.message}\n${error.stderr}`;
  return /\bHTTP 406\b/u.test(message)
    && /PullRequest\.diff too_large|diff exceeded the maximum number of files/u.test(message);
}

async function readRevision(context: DiffContext, number: number): Promise<PullRequestRevision> {
  const result = await context.runGitHub([
    "api", `repos/{owner}/{repo}/pulls/${number}`, "--jq",
    "{base: .base.sha, head: .head.sha, files: .changed_files}",
  ]);
  const value = parseResponse(result);
  if (!isObject(value) || typeof value.files !== "number"
    || !Number.isSafeInteger(value.files) || value.files < 0) {
    throw new GitCommandError("GitHub returned invalid pull request revision metadata.");
  }
  return {
    base: pullRequestCommitId(value.base),
    head: pullRequestCommitId(value.head),
    files: value.files,
  };
}

function filePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new GitCommandError("GitHub returned an invalid pull request file path.");
  }
  return value;
}

function renderFile(value: unknown): { path: string; patch: string } {
  if (!isObject(value) || typeof value.status !== "string"
    || (value.patch !== undefined && value.patch !== null && typeof value.patch !== "string")) {
    throw new GitCommandError("GitHub returned invalid pull request file data.");
  }
  const path = filePath(value.filename);
  const hasPreviousPath = value.previous_filename !== undefined && value.previous_filename !== null;
  const oldPath = hasPreviousPath ? filePath(value.previous_filename) : path;
  if (value.status === "renamed" && !hasPreviousPath) {
    throw new GitCommandError("GitHub omitted the previous path of a renamed file.");
  }
  const oldHeader = value.status === "added" ? "/dev/null" : JSON.stringify(`a/${oldPath}`);
  const newHeader = value.status === "removed" ? "/dev/null" : JSON.stringify(`b/${path}`);
  const lines = [
    `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${path}`)}`,
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
  ];
  if (typeof value.patch === "string" && value.patch.length > 0) {
    lines.push(value.patch.replace(/\n$/u, ""));
  } else {
    lines.push("GitHub did not provide a text diff for this file.");
  }
  return { path, patch: `${lines.join("\n")}\n` };
}

function collectFilePatches() {
  const paths = new Set<string>();
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    get size() { return paths.size; },
    add(value: unknown) {
      const file = renderFile(value);
      if (paths.has(file.path)) {
        throw new GitCommandError("GitHub returned duplicate diff files. Refresh to try again.");
      }
      paths.add(file.path);
      if (truncated) return;
      const patchBytes = Buffer.byteLength(file.patch);
      if (bytes + patchBytes > MAX_DIFF_BYTES) {
        truncated = true;
        return;
      }
      chunks.push(file.patch);
      bytes += patchBytes;
    },
    result(headRefOid: string, fileLimitReached = false) {
      return { stdout: chunks.join(""), truncated: truncated || fileLimitReached, headRefOid };
    },
  };
}

async function readFilePages(context: DiffContext, number: number, revision: PullRequestRevision) {
  if (revision.files > MAX_API_FILES) {
    throw new GitCommandError(
      `This pull request has ${revision.files} files. Fetch its base and head commits locally to view more than ${MAX_API_FILES} files.`,
    );
  }
  const patches = collectFilePatches();
  const pages = Math.ceil(revision.files / FILES_PER_PAGE);
  for (let page = 1; page <= pages; page += 1) {
    const result = await context.runGitHub([
      "api", `repos/{owner}/{repo}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      "--jq", "[.[] | {filename, previous_filename, status, patch}]",
    ], { maxBytes: MAX_DIFF_BYTES, timeout: 120_000 });
    const files = parseResponse(result);
    if (!Array.isArray(files) || files.length !== Math.min(FILES_PER_PAGE, revision.files - patches.size)) {
      throw new GitCommandError("GitHub returned an incomplete pull request file list. Refresh to try again.");
    }
    for (const value of files) patches.add(value);
  }
  const current = await readRevision(context, number);
  if (current.base !== revision.base || current.head !== revision.head || current.files !== revision.files) {
    throw new GitCommandError("The pull request changed while its diff was loading. Refresh to try again.");
  }
  return patches.result(revision.head);
}

async function readCommitDiff(context: DiffContext, commitOid: string) {
  const local = await context.runGit([
    "-c", "core.quotePath=false", "show", "--format=", "--patch", "--root",
    "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--no-color",
    "--src-prefix=a/", "--dst-prefix=b/", commitOid, "--",
  ], { acceptedExitCodes: [0, 1, 128], maxBytes: MAX_DIFF_BYTES, timeout: 120_000 });
  if (local.exitCode === 0) {
    return { stdout: local.stdout, truncated: local.truncated, headRefOid: commitOid };
  }

  const patches = collectFilePatches();
  for (let page = 1; page <= MAX_API_FILES / FILES_PER_PAGE; page += 1) {
    const response = await context.runGitHub([
      "api", `repos/{owner}/{repo}/commits/${commitOid}?per_page=${FILES_PER_PAGE}&page=${page}`,
      "--jq", "{sha, files: [.files[] | {filename, previous_filename, status, patch}]}",
    ], { maxBytes: MAX_DIFF_BYTES, timeout: 120_000 });
    const value = parseResponse(response);
    if (!isObject(value) || value.sha !== commitOid || !Array.isArray(value.files)
      || value.files.length > FILES_PER_PAGE) {
      throw new GitCommandError("GitHub returned an invalid commit diff response.");
    }
    for (const file of value.files) patches.add(file);
    if (value.files.length < FILES_PER_PAGE) return patches.result(commitOid);
  }
  return patches.result(commitOid, true);
}

export async function readGitHubPullRequestDiff(context: DiffContext, number: number, commitOid?: unknown) {
  if (commitOid !== undefined) return readCommitDiff(context, pullRequestCommitId(commitOid).toLowerCase());
  const [diff, headResult] = await Promise.all([
    context.runGitHub(["pr", "diff", String(number), "--color", "never"]).catch((error: unknown) => {
      if (!isOversizedDiff(error)) throw error;
      return null;
    }),
    context.runGitHub(["pr", "view", String(number), "--json", "headRefOid"]),
  ]);
  if (diff) {
    const head = parseResponse(headResult);
    return {
      stdout: diff.stdout,
      truncated: diff.truncated,
      headRefOid: pullRequestCommitId(isObject(head) ? head.headRefOid : undefined),
    };
  }

  const revision = await readRevision(context, number);
  const local = await context.runGit([
    "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
    "--src-prefix=a/", "--dst-prefix=b/", `${revision.base}...${revision.head}`, "--",
  ], { acceptedExitCodes: [0, 1, 128], maxBytes: MAX_DIFF_BYTES, timeout: 120_000 });
  if (local.exitCode === 0) {
    return { stdout: local.stdout, truncated: local.truncated, headRefOid: revision.head };
  }
  return readFilePages(context, number, revision);
}
