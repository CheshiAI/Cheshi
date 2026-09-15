import { GitCommandError, runCommand } from "./git-command.mts";
import { discardGitFileChanges, prepareGitDiscard } from "./git-discard.mts";
import {
  addGitHubPullRequestComment,
  addGitHubPullRequestReviewComment,
  checkoutGitHubPullRequest,
  cleanupGitHubPullRequestBranch,
  createGitHubPullRequest,
  deleteGitHubPullRequestBranch,
  getGitHubPullRequestBranchCleanupStatus,
  getGitHubPullRequestDetails,
  getGitHubPullRequestDiff,
  getMergedGitHubPullRequestBranchState,
  inspectGitHubPullRequestBranchCleanup,
  listGitHubPullRequests,
  mergeGitHubPullRequest,
  submitGitHubPullRequestReview,
} from "./github-pull-request-service.mts";
import { parseBranches, parseCommits, parseStatus } from "./git-parsers.mts";
import type {
  CommandResult,
  GitCommandOptions,
  GitRepositoryWatchOptions,
  GitSnapshot,
} from "./git-types.mts";
import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
export { GitCommandError } from "./git-command.mts";

const DEFAULT_WATCH_DEBOUNCE_MS = 150;
const GIT_LOG_ARGS = [
  "log",
  "--max-count=100",
  "--topo-order",
  "--date=iso-strict",
  "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%P%x1e",
];

function resolveGitDirectory(workspaceRoot: string, value: string) {
  const directory = value.trim();
  if (!directory)
    throw new GitCommandError("Git returned an empty repository directory.");
  return path.resolve(workspaceRoot, directory);
}

function isGitObjectEvent(filename: { toString: () => string } | null) {
  if (filename === null) return false;
  const relativePath = filename.toString().split(path.sep).join("/");
  return relativePath === "objects" || relativePath.startsWith("objects/");
}

function repositoryWatchTargets(directories: Set<string>) {
  const targets = new Map();
  for (const directory of directories) {
    targets.set(directory, false);
    for (const childName of ["refs", "logs"]) {
      const childDirectory = path.join(directory, childName);
      if (existsSync(childDirectory)) targets.set(childDirectory, true);
    }
  }
  return targets;
}

export class GitService {
  ghExecutable: string;
  gitExecutable: string;
  workspaceRoot: string;
  constructor(options: {
    workspaceRoot: string;
    gitExecutable?: string;
    ghExecutable?: string;
  }) {
    if (
      typeof options?.workspaceRoot !== "string" ||
      !path.isAbsolute(options.workspaceRoot)
    ) {
      throw new TypeError("Git workspace root must be an absolute path.");
    }
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.gitExecutable = options.gitExecutable?.trim() || "git";
    this.ghExecutable = options.ghExecutable?.trim() || "gh";
  }

  /**
   * @param {string[]} args
   * @param {GitCommandOptions} [options]
   * @returns {Promise<CommandResult>}
   */
  async runGit(
    args: string[],
    options: GitCommandOptions = {},
  ): Promise<CommandResult> {
    return runCommand(this.gitExecutable, ["-C", this.workspaceRoot, ...args], {
      cwd: this.workspaceRoot,
      ...options,
    });
  }

  /**
   * @param {string[]} args
   * @param {GitCommandOptions} [options]
   * @returns {Promise<CommandResult>}
   */
  async runGitHub(
    args: string[],
    options: GitCommandOptions = {},
  ): Promise<CommandResult> {
    return runCommand(this.ghExecutable, args, {
      cwd: this.workspaceRoot,
      ...options,
    });
  }

  /**
   * Watch Git metadata writes without periodically launching Git commands.
   *
   * @param {() => void} onChange
   * @param {GitRepositoryWatchOptions} [options]
   * @returns {Promise<() => void>}
   */
  async watchRepository(
    onChange: () => void,
    options: GitRepositoryWatchOptions = {},
  ): Promise<() => void> {
    if (typeof onChange !== "function") {
      throw new TypeError("Git repository change handler must be a function.");
    }
    const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new TypeError(
        "Git repository watch debounce must be a non-negative number.",
      );
    }
    const onError = options.onError ?? (() => {});
    if (typeof onError !== "function") {
      throw new TypeError(
        "Git repository watch error handler must be a function.",
      );
    }

    let directories;
    try {
      const [gitDirectory, commonDirectory] = await Promise.all([
        this.runGit(["rev-parse", "--git-dir"]),
        this.runGit(["rev-parse", "--git-common-dir"]),
      ]);
      directories = new Set([
        resolveGitDirectory(this.workspaceRoot, gitDirectory.stdout),
        resolveGitDirectory(this.workspaceRoot, commonDirectory.stdout),
      ]);
    } catch {
      return () => {};
    }

    let closed = false;
    let timer: string | number | NodeJS.Timeout | null | undefined = null;
    const watchers: FSWatcher[] = [];
    const reportError = (error: unknown) => {
      try {
        onError(error);
      } catch {
        // Error reporting must not turn an OS watcher failure into an uncaught exception.
      }
    };
    const scheduleChange = (filename: string | null) => {
      if (closed || isGitObjectEvent(filename)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (closed) return;
        try {
          onChange();
        } catch (error) {
          reportError(error);
        }
      }, debounceMs);
      timer.unref?.();
    };

    try {
      for (const [directory, recursive] of repositoryWatchTargets(
        directories,
      )) {
        const watcher = watch(
          directory,
          { recursive },
          (_eventType, filename) => {
            scheduleChange(filename);
          },
        );
        watcher.on("error", reportError);
        watchers.push(watcher);
      }
    } catch (error) {
      for (const watcher of watchers) watcher.close();
      throw error;
    }

    return () => {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  resolvePath(relativePath: string) {
    if (
      typeof relativePath !== "string" ||
      !relativePath.trim() ||
      relativePath.includes("\0")
    ) {
      throw new TypeError(
        "Git path must be a non-empty workspace-relative path.",
      );
    }
    if (path.isAbsolute(relativePath)) {
      throw new TypeError("Git path must be workspace-relative.");
    }
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    const workspacePrefix = `${this.workspaceRoot}${path.sep}`;
    if (
      resolved !== this.workspaceRoot &&
      !resolved.startsWith(workspacePrefix)
    ) {
      throw new TypeError("Git path must stay inside the workspace.");
    }
    return {
      relativePath: path.relative(this.workspaceRoot, resolved),
      absolutePath: resolved,
    };
  }

  async assertBranchName(branchName: string) {
    if (
      typeof branchName !== "string" ||
      !branchName.trim() ||
      branchName.startsWith("-")
    ) {
      throw new TypeError("Git branch name must be a non-empty branch name.");
    }
    const normalized = branchName.trim();
    await this.runGit(["check-ref-format", "--branch", normalized]);
    return normalized;
  }

  async assertBranchReference(branchReference: string) {
    if (
      typeof branchReference !== "string" ||
      (!branchReference.startsWith("refs/heads/") &&
        !branchReference.startsWith("refs/remotes/"))
    ) {
      throw new TypeError(
        "Git branch reference must identify a local or remote branch.",
      );
    }
    const normalized = branchReference.trim();
    const result = await this.runGit(
      ["show-ref", "--verify", "--quiet", normalized],
      { acceptedExitCodes: [0, 1] },
    );
    if (result.exitCode !== 0)
      throw new GitCommandError(`Git branch does not exist: ${normalized}.`);
    return normalized;
  }

  async branchReferenceExists(branchReference: string) {
    const result = await this.runGit(
      ["show-ref", "--verify", "--quiet", branchReference],
      { acceptedExitCodes: [0, 1] },
    );
    return result.exitCode === 0;
  }

  async getBranchCommits(branchReference: string) {
    const reference = await this.assertBranchReference(branchReference);
    const result = await this.runGit([...GIT_LOG_ARGS, reference, "--"]);
    return parseCommits(result.stdout);
  }

  async getSnapshot(): Promise<GitSnapshot> {
    try {
      const repository = await this.runGit([
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      if (repository.stdout.trim() !== "true") {
        return {
          available: false,
          message: "The workspace is not a Git worktree.",
        };
      }
    } catch (error) {
      return {
        available: false,
        message:
          error instanceof Error
            ? error.message
            : "Git is unavailable for this workspace.",
      };
    }

    const [statusResult, branchesResult, headResult, commitsResult] =
      await Promise.all([
        this.runGit([
          "--no-optional-locks",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        this.runGit([
          "for-each-ref",
          "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:track)%00%(HEAD)",
          "refs/heads",
          "refs/remotes",
        ]),
        this.runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
          acceptedExitCodes: [0, 1],
        }),
        this.runGit([...GIT_LOG_ARGS, "HEAD", "--"], { acceptedExitCodes: [0, 128] }),
      ]);

    const branches = parseBranches(branchesResult.stdout);
    const currentBranch =
      branches.find((branch) => branch.current && !branch.remote) ?? null;
    const detached = !currentBranch && headResult.exitCode === 0;
    const head = detached
      ? (await this.runGit(["rev-parse", "--short", "HEAD"])).stdout.trim()
      : (currentBranch?.name ?? null);
    const upstreamPublished = Boolean(
      currentBranch?.upstream &&
      currentBranch.upstreamRemote &&
      currentBranch.upstreamRemote !== "." &&
      branches.some((branch) => (
        branch.remote && branch.name === currentBranch.upstream
      )),
    );
    let ahead = 0;
    let behind = 0;
    if (currentBranch?.upstream) {
      const divergence = await this.runGit(
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        { acceptedExitCodes: [0, 128] },
      );
      if (divergence.exitCode === 0) {
        const [aheadValue = "0", behindValue = "0"] = divergence.stdout
          .trim()
          .split(/\s+/);
        ahead = Number.parseInt(aheadValue, 10) || 0;
        behind = Number.parseInt(behindValue, 10) || 0;
      }
    }
    let pullRequestBase = null;
    let pullRequestAhead = null;
    const pullRequestRemote = currentBranch
      ? currentBranch.upstreamRemote ?? await this.resolvePushRemote(currentBranch.name)
      : null;
    if (pullRequestRemote && pullRequestRemote !== ".") {
      const defaultBranch = await this.runGit(
        [
          "symbolic-ref",
          "--quiet",
          "--short",
          `refs/remotes/${pullRequestRemote}/HEAD`,
        ],
        { acceptedExitCodes: [0, 1, 128] },
      );
      if (defaultBranch.exitCode === 0) {
        pullRequestBase = defaultBranch.stdout.trim() || null;
        if (pullRequestBase) {
          const divergence = await this.runGit(
            [
              "rev-list",
              "--left-right",
              "--count",
              `${pullRequestBase}...HEAD`,
            ],
            { acceptedExitCodes: [0, 128] },
          );
          if (divergence.exitCode === 0) {
            const [, aheadValue = "0"] = divergence.stdout.trim().split(/\s+/u);
            pullRequestAhead = Number.parseInt(aheadValue, 10) || 0;
          }
        }
      }
    }

    return {
      available: true,
      message: "",
      head,
      detached,
      upstream: currentBranch?.upstream ?? null,
      upstreamPublished,
      ahead,
      behind,
      pullRequestBase,
      pullRequestAhead,
      changes: parseStatus(statusResult.stdout),
      branches,
      commits:
        headResult.exitCode === 0 ? parseCommits(commitsResult.stdout) : [],
    };
  }

  async getDiff(request: {
    scope: string;
    path?: string;
    commit?: string;
  } | null) {
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request)
    ) {
      throw new TypeError("Git diff request must be an object.");
    }
    const scope = request.scope;
    if (scope !== "working" && scope !== "staged" && scope !== "commit") {
      throw new TypeError("Git diff scope is invalid.");
    }
    const requestedPath =
      typeof request.path === "string" && request.path.trim()
        ? this.resolvePath(request.path).relativePath
        : null;
    let commit = null;
    let result;
    if (scope === "commit") {
      if (
        typeof request.commit !== "string" ||
        !/^[0-9a-fA-F]{4,64}$/.test(request.commit)
      ) {
        throw new TypeError("Git commit must be a hexadecimal object id.");
      }
      commit = request.commit;
      result = await this.runGit([
        "show",
        "--format=",
        "--no-ext-diff",
        "--no-color",
        "--patch",
        commit,
        ...(requestedPath ? ["--", requestedPath] : []),
      ]);
    } else {
      if (!requestedPath)
        throw new TypeError("Working tree diffs require a file path.");
      result = await this.runGit([
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--patch",
        ...(scope === "staged" ? ["--cached"] : []),
        "--",
        requestedPath,
      ]);
      if (!result.stdout && scope === "working") {
        const status = await this.runGit([
          "--no-optional-locks",
          "status",
          "--porcelain=v1",
          "-z",
          "--",
          requestedPath,
        ]);
        const change = parseStatus(status.stdout)[0];
        if (change?.untracked) {
          result = await this.runGit(
            [
              "diff",
              "--no-index",
              "--no-color",
              "--patch",
              "--",
              "/dev/null",
              requestedPath,
            ],
            { acceptedExitCodes: [0, 1] },
          );
        }
      }
    }

    return {
      scope,
      path: requestedPath,
      commit,
      patch: result.stdout,
      truncated: result.truncated,
      binary: /^(?:Binary files |GIT binary patch$)/m.test(result.stdout),
    };
  }

  async stagePaths(paths: any) {
    const normalizedPaths = this.normalizePaths(paths);
    await this.runGit(["add", "--", ...normalizedPaths]);
    return this.getSnapshot();
  }

  async prepareDiscard(request: unknown) {
    return prepareGitDiscard(this, request);
  }

  async discardChanges(request: unknown, trashItem: (absolutePath: string) => Promise<void>) {
    return discardGitFileChanges(this, request, trashItem);
  }

  async unstagePaths(paths: any) {
    const normalizedPaths = this.normalizePaths(paths);
    const head = await this.runGit(
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      { acceptedExitCodes: [0, 1] },
    );
    if (head.exitCode === 0) {
      await this.runGit(["restore", "--staged", "--", ...normalizedPaths]);
    } else {
      await this.runGit(["rm", "--cached", "--", ...normalizedPaths]);
    }
    return this.getSnapshot();
  }

  async commit(message: string) {
    if (typeof message !== "string" || !message.trim()) {
      throw new TypeError("Git commit message must be non-empty.");
    }
    if (message.length > 20_000)
      throw new TypeError("Git commit message is too long.");
    const result = await this.runGit(["commit", "-m", message.trim()], {
      timeout: 120_000,
    });
    return { output: result.stdout.trim(), snapshot: await this.getSnapshot() };
  }

  async checkoutBranch(branchName: string) {
    const branch = await this.assertBranchName(branchName);
    const status = await this.runGit([
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (status.stdout.length > 0) {
      throw new GitCommandError(
        "Commit or discard local changes before switching branches.",
      );
    }
    await this.runGit(["switch", branch], { timeout: 120_000 });
    return this.getSnapshot();
  }

  async createBranch(branchName: string, startPoint: string | null = null) {
    const branch = await this.assertBranchName(branchName);
    const reference =
      startPoint === null ? null : await this.assertBranchReference(startPoint);
    await this.runGit(
      ["switch", "-c", branch, ...(reference ? [reference] : [])],
      { timeout: 120_000 },
    );
    return this.getSnapshot();
  }

  async updateBranch(branchReference: any) {
    const reference = await this.assertBranchReference(branchReference);
    if (reference.startsWith("refs/remotes/")) {
      const remoteBranch = reference.slice("refs/remotes/".length);
      const separator = remoteBranch.indexOf("/");
      if (separator < 1)
        throw new GitCommandError(
          `Remote branch reference is invalid: ${reference}.`,
        );
      const remote = remoteBranch.slice(0, separator);
      const result = await this.runGit(["fetch", "--prune", remote], {
        timeout: 120_000,
      });
      return {
        output:
          result.stderr.trim() || result.stdout.trim() || `Fetched ${remote}.`,
        snapshot: await this.getSnapshot(),
      };
    }

    const branch = reference.slice("refs/heads/".length);
    const upstreamResult = await this.runGit([
      "for-each-ref",
      "--format=%(upstream)",
      reference,
    ]);
    const upstreamValue = upstreamResult.stdout.trim();
    if (!upstreamValue)
      throw new GitCommandError(`Branch ${branch} has no upstream branch.`);
    const upstream = await this.assertBranchReference(upstreamValue);
    if (upstream.startsWith("refs/remotes/")) {
      const remoteBranch = upstream.slice("refs/remotes/".length);
      const separator = remoteBranch.indexOf("/");
      if (separator < 1)
        throw new GitCommandError(
          `Upstream branch reference is invalid: ${upstream}.`,
        );
      await this.runGit(
        ["fetch", "--prune", remoteBranch.slice(0, separator)],
        { timeout: 120_000 },
      );
    }

    const [branchHead, upstreamHead] = await Promise.all([
      this.runGit(["rev-parse", reference]),
      this.runGit(["rev-parse", upstream]),
    ]);
    if (branchHead.stdout.trim() === upstreamHead.stdout.trim()) {
      return {
        output: `${branch} is already up to date.`,
        snapshot: await this.getSnapshot(),
      };
    }

    const canFastForward = await this.runGit(
      ["merge-base", "--is-ancestor", reference, upstream],
      { acceptedExitCodes: [0, 1] },
    );
    if (canFastForward.exitCode !== 0) {
      const upstreamIsAncestor = await this.runGit(
        ["merge-base", "--is-ancestor", upstream, reference],
        { acceptedExitCodes: [0, 1] },
      );
      if (upstreamIsAncestor.exitCode === 0) {
        return {
          output: `${branch} is ahead of its upstream branch.`,
          snapshot: await this.getSnapshot(),
        };
      }
      throw new GitCommandError(
        `Branch ${branch} has diverged from ${upstreamValue}; update it manually.`,
      );
    }

    const current = await this.runGit(["symbolic-ref", "--quiet", "HEAD"], {
      acceptedExitCodes: [0, 1],
    });
    const result =
      current.stdout.trim() === reference
        ? await this.runGit(["merge", "--ff-only", upstream], {
            timeout: 120_000,
          })
        : await this.runGit(["branch", "--force", branch, upstream], {
            timeout: 120_000,
          });
    return {
      output:
        result.stdout.trim() || result.stderr.trim() || `Updated ${branch}.`,
      snapshot: await this.getSnapshot(),
    };
  }

  async fetch() {
    const result = await this.runGit(["fetch", "--prune"], {
      timeout: 120_000,
    });
    return {
      output: result.stderr.trim() || result.stdout.trim(),
      snapshot: await this.getSnapshot(),
    };
  }

  private async resolvePushRemote(branch: string): Promise<string | null> {
    const [configuredBranchRemote, configuredPushRemote, remoteList] =
      await Promise.all([
        this.runGit(["config", "--get", `branch.${branch}.remote`], {
          acceptedExitCodes: [0, 1],
        }),
        this.runGit(["config", "--get", "remote.pushDefault"], {
          acceptedExitCodes: [0, 1],
        }),
        this.runGit(["remote"]),
      ]);
    const remotes = remoteList.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const configuredRemotes = [
      configuredBranchRemote.stdout.trim(),
      configuredPushRemote.stdout.trim(),
    ];
    return configuredRemotes.find(
      (entry) => entry !== "." && remotes.includes(entry),
    ) ?? (remotes.includes("origin") ? "origin" : null)
      ?? (remotes.length === 1 ? remotes[0]! : null);
  }

  async pushCurrentBranch() {
    const snapshot = await this.getSnapshot();
    if (!snapshot.available)
      throw new GitCommandError(
        snapshot.message || "Git repository is unavailable.",
      );
    if (snapshot.detached || !snapshot.head) {
      throw new GitCommandError("Check out a local branch before pushing.");
    }

    const branch = await this.assertBranchName(snapshot.head);
    let result;
    if (snapshot.upstream) {
      result = await this.runGit(["push"], { timeout: 120_000 });
    } else {
      const remote = await this.resolvePushRemote(branch);
      if (!remote || remote.startsWith("-")) {
        throw new GitCommandError(
          "Configure a Git remote before pushing this branch.",
        );
      }
      result = await this.runGit(["push", "--set-upstream", remote, branch], {
        timeout: 120_000,
      });
    }

    return {
      output:
        result.stderr.trim() || result.stdout.trim() || `Pushed ${branch}.`,
      snapshot: await this.getSnapshot(),
    };
  }

  async listPullRequests() {
    return listGitHubPullRequests(this);
  }

  async getPullRequestDetails(number: any) {
    return getGitHubPullRequestDetails(this, number);
  }

  async getPullRequestDiff(number: unknown, commitOid?: unknown) {
    return getGitHubPullRequestDiff(this, number, commitOid);
  }

  async addPullRequestComment(request: any) {
    return addGitHubPullRequestComment(this, request);
  }

  async addPullRequestReviewComment(request: any) {
    return addGitHubPullRequestReviewComment(this, request);
  }

  async submitPullRequestReview(request: any) {
    return submitGitHubPullRequestReview(this, request);
  }

  async createPullRequest() {
    return createGitHubPullRequest(this);
  }

  async checkoutPullRequest(number: any) {
    return checkoutGitHubPullRequest(this, number);
  }

  async mergePullRequest(request: { number: any; method: string } | null) {
    return mergeGitHubPullRequest(this, request);
  }

  async getMergedPullRequestBranchState(number: any) {
    return getMergedGitHubPullRequestBranchState(this, number);
  }

  async inspectPullRequestBranchCleanup(pullRequest: { number: any; branch: any; baseBranch: any; headRefOid: any }, snapshot: GitSnapshot) {
    return inspectGitHubPullRequestBranchCleanup(this, pullRequest, snapshot);
  }

  async getPullRequestBranchCleanupStatus(number: any) {
    return getGitHubPullRequestBranchCleanupStatus(this, number);
  }

  async cleanupPullRequestBranch(number: any) {
    return cleanupGitHubPullRequestBranch(this, number);
  }

  async deletePullRequestBranch(number: any) {
    return deleteGitHubPullRequestBranch(this, number);
  }

  normalizePaths(paths: any[]) {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 1_000) {
      throw new TypeError("Git paths must contain between 1 and 1000 entries.");
    }
    return [
      ...new Set(paths.map((entry) => this.resolvePath(entry).relativePath)),
    ];
  }
}
