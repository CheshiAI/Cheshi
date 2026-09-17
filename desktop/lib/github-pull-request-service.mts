import { waitForPullRequestMergeState } from "./github-pull-request-merge-state.mts";
import { GitCommandError } from "./git-command.mts";
import { readGitHubPullRequestDiff } from "./github-pull-request-diff.mts";
import type {
  CommandOptions,
  CommandResult,
  GitCommandOptions,
  GitSnapshot,
} from "./git-types.mts";
import {
  assertPullRequestCanMerge,
  assertPullRequestList,
  assertPullRequestNumber,
  GITHUB_PULL_REQUEST_MERGE_METHODS,
  githubBranchReferencePath,
  githubUnavailableMessage,
  normalizePullRequest,
  normalizePullRequestBranchDeletionState,
  normalizePullRequestCommentRequest,
  normalizePullRequestDetails,
  normalizePullRequestMergeState,
  normalizePullRequestReviewCommentRequest,
  normalizePullRequestReviewData,
  normalizePullRequestReviewSubmissionRequest,
  pullRequestNodeId,
} from "./github-pull-request-data.mts";
import {
  GITHUB_ADD_PULL_REQUEST_REVIEW_THREAD_MUTATION,
  GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY,
  GITHUB_START_PULL_REQUEST_REVIEW_MUTATION,
  GITHUB_SUBMIT_PULL_REQUEST_REVIEW_MUTATION,
} from "./github-pull-request-queries.mts";

const PULL_REQUEST_SUMMARY_FIELDS = "number,title,url,headRefName,baseRefName,isCrossRepository,author,updatedAt,isDraft,reviewDecision,changedFiles";

interface GitHubPullRequestContext {
  runGit(args: string[], options?: GitCommandOptions): Promise<CommandResult>;
  runGitHub(args: string[], options?: Omit<CommandOptions, "cwd">): Promise<CommandResult>;
  getSnapshot(): Promise<GitSnapshot>;
  assertBranchName(branchName: string): Promise<string>;
  branchReferenceExists(branchReference: string): Promise<boolean>;
  fetch(): Promise<{ output: string; snapshot: GitSnapshot }>;
  getPullRequestDetails(number: unknown): Promise<ReturnType<typeof normalizePullRequestDetails>>;
  getMergedPullRequestBranchState(number: unknown): ReturnType<typeof getMergedGitHubPullRequestBranchState>;
  inspectPullRequestBranchCleanup(
    pullRequest: Awaited<ReturnType<typeof getMergedGitHubPullRequestBranchState>>,
    snapshot: GitSnapshot,
  ): ReturnType<typeof inspectGitHubPullRequestBranchCleanup>;
}

export async function listGitHubPullRequests(context: GitHubPullRequestContext) {
  try {
    const result = await context.runGitHub([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      PULL_REQUEST_SUMMARY_FIELDS,
    ]);
    const parsed = assertPullRequestList(JSON.parse(result.stdout || "[]"));
    return {
      available: true,
      message: "",
      pullRequests: parsed.map(normalizePullRequest),
    };
  } catch (error) {
    return {
      available: false,
      message: githubUnavailableMessage(error),
      pullRequests: [],
    };
  }
}

export async function getGitHubPullRequestDetails(context: GitHubPullRequestContext, number: any) {
  const normalizedNumber = assertPullRequestNumber(number);
  const result = await context.runGitHub([
    "pr",
    "view",
    String(normalizedNumber),
    "--json",
    "id,comments,commits,headRefOid",
  ]);
  const pullRequest = JSON.parse(result.stdout || "{}");
  const pullRequestId = pullRequestNodeId(pullRequest.id, "ID");
  const reviewResult = await context.runGitHub(
    [
      "api",
      "graphql",
      "--raw-field",
      `query=${GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY}`,
      "--raw-field",
      `pullRequestId=${pullRequestId}`,
    ],
    { timeout: 120_000 },
  );
  return normalizePullRequestDetails(
    pullRequest,
    normalizePullRequestReviewData(
      JSON.parse(reviewResult.stdout || "{}"),
      pullRequestId,
    ),
    normalizedNumber,
  );
}

export async function getGitHubPullRequestDiff(context: GitHubPullRequestContext, number: unknown, commitOid?: unknown) {
  const normalizedNumber = assertPullRequestNumber(number);
  const result = await readGitHubPullRequestDiff(context, normalizedNumber, commitOid);
  return {
    number: normalizedNumber,
    path: null,
    headRefOid: result.headRefOid,
    patch: result.stdout,
    truncated: result.truncated,
    binary: /^(?:Binary files |GIT binary patch$)/m.test(result.stdout),
  };
}

export async function addGitHubPullRequestComment(context: GitHubPullRequestContext, request: any) {
  const normalizedRequest = normalizePullRequestCommentRequest(request);
  await context.runGitHub(
    [
      "pr",
      "comment",
      String(normalizedRequest.number),
      "--body",
      normalizedRequest.body,
    ],
    { timeout: 120_000 },
  );
  return context.getPullRequestDetails(normalizedRequest.number);
}

export async function addGitHubPullRequestReviewComment(context: GitHubPullRequestContext, request: any) {
  const normalizedRequest = normalizePullRequestReviewCommentRequest(request);
  if (normalizedRequest.mode === "comment") {
    await context.runGitHub(
      [
        "api",
        `repos/{owner}/{repo}/pulls/${normalizedRequest.number}/comments`,
        "--method",
        "POST",
        "--raw-field",
        `body=${normalizedRequest.body}`,
        "--raw-field",
        `commit_id=${normalizedRequest.commitId}`,
        "--raw-field",
        `path=${normalizedRequest.path}`,
        "--field",
        `line=${normalizedRequest.line}`,
        "--raw-field",
        `side=${normalizedRequest.side}`,
      ],
      { timeout: 120_000 },
    );
  } else if (normalizedRequest.pendingReviewId) {
    await context.runGitHub(
      [
        "api",
        "graphql",
        "--raw-field",
        `query=${GITHUB_ADD_PULL_REQUEST_REVIEW_THREAD_MUTATION}`,
        "--raw-field",
        `pullRequestReviewId=${normalizedRequest.pendingReviewId}`,
        "--raw-field",
        `path=${normalizedRequest.path}`,
        "--field",
        `line=${normalizedRequest.line}`,
        "--raw-field",
        `side=${normalizedRequest.side}`,
        "--raw-field",
        `body=${normalizedRequest.body}`,
      ],
      { timeout: 120_000 },
    );
  } else {
    await context.runGitHub(
      [
        "api",
        "graphql",
        "--raw-field",
        `query=${GITHUB_START_PULL_REQUEST_REVIEW_MUTATION}`,
        "--raw-field",
        `pullRequestId=${normalizedRequest.pullRequestId}`,
        "--raw-field",
        `commitOID=${normalizedRequest.commitId}`,
        "--raw-field",
        `path=${normalizedRequest.path}`,
        "--field",
        `line=${normalizedRequest.line}`,
        "--raw-field",
        `side=${normalizedRequest.side}`,
        "--raw-field",
        `body=${normalizedRequest.body}`,
      ],
      { timeout: 120_000 },
    );
  }
  return context.getPullRequestDetails(normalizedRequest.number);
}

export async function submitGitHubPullRequestReview(context: GitHubPullRequestContext, request: any) {
  const normalizedRequest =
    normalizePullRequestReviewSubmissionRequest(request);
  await context.runGitHub(
    [
      "api",
      "graphql",
      "--raw-field",
      `query=${GITHUB_SUBMIT_PULL_REQUEST_REVIEW_MUTATION}`,
      "--raw-field",
      `pullRequestReviewId=${normalizedRequest.reviewId}`,
      "--raw-field",
      `event=${normalizedRequest.event}`,
    ],
    { timeout: 120_000 },
  );
  return context.getPullRequestDetails(normalizedRequest.number);
}

export async function createGitHubPullRequest(context: GitHubPullRequestContext) {
  const snapshot = await context.getSnapshot();
  if (!snapshot.available)
    throw new GitCommandError(
      snapshot.message || "Git repository is unavailable.",
    );
  if (snapshot.detached || !snapshot.head) {
    throw new GitCommandError(
      "Check out a local branch before creating a pull request.",
    );
  }
  if (snapshot.pullRequestAhead === 0) {
    throw new GitCommandError(
      `No commits to propose from ${snapshot.head} to ${snapshot.pullRequestBase ?? "the default branch"}.`,
    );
  }
  if (!snapshot.upstream || !snapshot.upstreamPublished) {
    throw new GitCommandError(
      `Push ${snapshot.head} before creating a pull request.`,
    );
  }
  if (snapshot.ahead > 0) {
    throw new GitCommandError(
      `Push ${snapshot.head} before creating a pull request.`,
    );
  }

  await context.runGitHub(["pr", "create", "--fill"], { timeout: 120_000 });
  const result = await context.runGitHub([
    "pr",
    "view",
    "--json",
    PULL_REQUEST_SUMMARY_FIELDS,
  ]);
  return normalizePullRequest(JSON.parse(result.stdout || "{}"));
}

export async function checkoutGitHubPullRequest(context: GitHubPullRequestContext, number: any) {
  const normalizedNumber = assertPullRequestNumber(number);
  await context.runGitHub(["pr", "checkout", String(normalizedNumber)], {
    timeout: 120_000,
  });
  return context.getSnapshot();
}

export async function mergeGitHubPullRequest(context: GitHubPullRequestContext, request: { number: any; method: string } | null) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new TypeError("Pull request merge request must be an object.");
  }
  const number = assertPullRequestNumber(request.number);
  if (!GITHUB_PULL_REQUEST_MERGE_METHODS.has(request.method)) {
    throw new TypeError("Pull request merge method is invalid.");
  }

  const state = await waitForPullRequestMergeState(async () => {
    const stateResult = await context.runGitHub([
      "pr",
      "view",
      String(number),
      "--json",
      "headRefOid,headRefName,baseRefName,isCrossRepository,isDraft,mergeable,mergeStateStatus",
    ]);
    return normalizePullRequestMergeState(JSON.parse(stateResult.stdout || "{}"));
  }, undefined, () => context.runGitHub([
    "api",
    `repos/{owner}/{repo}/pulls/${number}`,
    "--jq",
    "{mergeable,mergeable_state}",
  ]));
  assertPullRequestCanMerge(state);
  const result = await context.runGitHub(
    [
      "pr",
      "merge",
      String(number),
      `--${request.method}`,
      "--match-head-commit",
      state.headRefOid,
    ],
    { timeout: 120_000 },
  );
  return {
    number,
    method: request.method,
    headRefName: state.headRefName,
    branchDeletionAvailable:
      !state.crossRepository && state.headRefName !== state.baseRefName,
    output:
      result.stderr.trim() ||
      result.stdout.trim() ||
      `Merged pull request #${number}.`,
  };
}

export async function getMergedGitHubPullRequestBranchState(context: GitHubPullRequestContext, number: any) {
  const normalizedNumber = assertPullRequestNumber(number);
  const stateResult = await context.runGitHub([
    "pr",
    "view",
    String(normalizedNumber),
    "--json",
    "state,headRefOid,headRefName,baseRefName,isCrossRepository",
  ]);
  const state = normalizePullRequestBranchDeletionState(
    JSON.parse(stateResult.stdout || "{}"),
  );
  if (state.state !== "MERGED") {
    throw new GitCommandError(
      "Only a merged pull request branch can be managed from this flow.",
    );
  }
  if (state.crossRepository) {
    throw new GitCommandError(
      "Branches from another repository must be managed in their source repository.",
    );
  }

  const [branch, baseBranch] = await Promise.all([
    context.assertBranchName(state.headRefName),
    context.assertBranchName(state.baseRefName),
  ]);
  if (branch === baseBranch) {
    throw new GitCommandError(
      "The pull request base branch cannot be deleted.",
    );
  }
  return {
    number: normalizedNumber,
    branch,
    baseBranch,
    headRefOid: state.headRefOid,
  };
}

export async function inspectGitHubPullRequestBranchCleanup(context: GitHubPullRequestContext, pullRequest: { number: any; branch: any; baseBranch: any; headRefOid: any }, snapshot: GitSnapshot) {
  if (!snapshot.available) {
    throw new GitCommandError(
      snapshot.message || "Git repository is unavailable.",
    );
  }

  const branchReference = `refs/heads/${pullRequest.branch}`;
  const baseReference = `refs/heads/${pullRequest.baseBranch}`;
  const localBranchExists = await context.branchReferenceExists(branchReference);
  const currentBranch = snapshot.detached ? null : (snapshot.head ?? null);
  const status = {
    number: pullRequest.number,
    branch: pullRequest.branch,
    baseBranch: pullRequest.baseBranch,
    currentBranch,
    upstream: null,
    state: "complete",
    canCleanup: false,
    canPush: false,
    branchAhead: 0,
    baseAhead: 0,
    baseBehind: 0,
    localBranchExists,
    message: `The local ${pullRequest.branch} branch has already been deleted.`,
    snapshot,
  };
  if (!localBranchExists) return status;

  if (!(await context.branchReferenceExists(baseReference))) {
    return {
      ...status,
      state: "base-missing",
      message: `The local ${pullRequest.baseBranch} branch is missing. Create or restore it before deleting ${pullRequest.branch}.`,
    };
  }

  const upstreamResult = await context.runGit([
    "for-each-ref",
    "--format=%(upstream)",
    baseReference,
  ]);
  const upstreamReference = upstreamResult.stdout.trim();
  if (!upstreamReference || !upstreamReference.startsWith("refs/remotes/")) {
    return {
      ...status,
      state: "upstream-missing",
      message: `${pullRequest.baseBranch} has no remote tracking branch. Configure its upstream before deleting ${pullRequest.branch}.`,
    };
  }
  const upstream = upstreamReference.slice("refs/remotes/".length);
  const statusWithUpstream = { ...status, upstream };
  if (!(await context.branchReferenceExists(upstreamReference))) {
    return {
      ...statusWithUpstream,
      state: "upstream-missing",
      message: `The tracked branch ${upstream} is unavailable. Fetch or repair the remote before continuing.`,
    };
  }

  const upstreamRemote = upstream.split("/")[0] ?? "";
  const remotePullRequestReference = `refs/remotes/${upstreamRemote}/${pullRequest.branch}`;
  const remoteBranchExists = Boolean(upstreamRemote) &&
    (await context.branchReferenceExists(remotePullRequestReference));

  const divergence = await context.runGit([
    "rev-list",
    "--left-right",
    "--count",
    `${baseReference}...${upstreamReference}`,
  ]);
  const [aheadValue = "0", behindValue = "0"] = divergence.stdout
    .trim()
    .split(/\s+/u);
  const baseAhead = Number.parseInt(aheadValue, 10) || 0;
  const baseBehind = Number.parseInt(behindValue, 10) || 0;
  const comparedStatus = { ...statusWithUpstream, baseAhead, baseBehind };

  if ((snapshot.changes?.length ?? 0) > 0) {
    return {
      ...comparedStatus,
      state: "worktree-dirty",
      message:
        "Commit or discard the current workspace changes before deleting the pull request branch.",
    };
  }

  const pullRequestHeadExists = await context.runGit(
    ["cat-file", "-e", `${pullRequest.headRefOid}^{commit}`],
    { acceptedExitCodes: [0, 1, 128] },
  );
  let branchMatchesPullRequestHead = false;
  if (pullRequestHeadExists.exitCode === 0) {
    const branchContainsPullRequestHead = await context.runGit(
      [
        "merge-base",
        "--is-ancestor",
        pullRequest.headRefOid,
        branchReference,
      ],
      { acceptedExitCodes: [0, 1] },
    );
    if (branchContainsPullRequestHead.exitCode === 0) {
      const branchAheadResult = await context.runGit([
        "rev-list",
        "--count",
        `${pullRequest.headRefOid}..${branchReference}`,
      ]);
      const branchAhead =
        Number.parseInt(branchAheadResult.stdout.trim(), 10) || 0;
      if (branchAhead > 0) {
        const unpushed = remoteBranchExists
          ? await context.runGit(["rev-list", "--count", `${remotePullRequestReference}..${branchReference}`])
          : null;
        const hasUnpushedCommits = !unpushed || Number.parseInt(unpushed.stdout.trim(), 10) > 0;
        const canPush = currentBranch === pullRequest.branch && hasUnpushedCommits;
        const nextStep = !hasUnpushedCommits
          ? "The commits are already pushed. Open a new pull request before deleting the branch."
          : currentBranch !== pullRequest.branch
            ? "Check out the branch before pushing it."
            : remoteBranchExists
              ? "Push the branch and open a new pull request."
              : "Push the branch to recreate its remote and open a new pull request.";
        return {
          ...comparedStatus,
          state: "local-commits-after-merge",
          canPush,
          branchAhead,
          message: `${pullRequest.branch} has ${branchAhead} local commit${branchAhead === 1 ? "" : "s"} created after pull request #${pullRequest.number} was merged. ${nextStep}`,
        };
      }
      branchMatchesPullRequestHead = true;
    }
  }

  if (!branchMatchesPullRequestHead) {
    const branchMerged = await context.runGit(
      ["merge-base", "--is-ancestor", branchReference, upstreamReference],
      { acceptedExitCodes: [0, 1] },
    );
    if (branchMerged.exitCode !== 0) {
      return {
        ...comparedStatus,
        state: "branch-not-merged",
        message: `${pullRequest.branch} contains commits that are not ancestors of ${upstream}. Review them before deleting the local branch.`,
      };
    }
  }
  if (remoteBranchExists) {
    const remoteMerged = await context.runGit(
      ["merge-base", "--is-ancestor", remotePullRequestReference, pullRequest.headRefOid],
      { acceptedExitCodes: [0, 1, 128] },
    );
    if (remoteMerged.exitCode !== 0) {
      return {
        ...comparedStatus,
        state: "branch-not-merged",
        message: `The remote ${pullRequest.branch} branch contains commits outside pull request #${pullRequest.number}. Review them in a new pull request before deleting the branch.`,
      };
    }
    return {
      ...comparedStatus,
      state: "remote-branch-present",
      message: `Delete the remote ${pullRequest.branch} branch before cleaning up the local branch.`,
    };
  }
  if (
    currentBranch !== pullRequest.branch &&
    currentBranch !== pullRequest.baseBranch
  ) {
    return {
      ...comparedStatus,
      state: "different-branch",
      message: `Check out ${pullRequest.branch} or ${pullRequest.baseBranch} before cleaning up the pull request branch.`,
    };
  }

  if (baseAhead > 0 && baseBehind > 0) {
    return {
      ...comparedStatus,
      state: "base-diverged",
      message: `${pullRequest.baseBranch} and ${upstream} have diverged. Resolve the branch manually before cleanup.`,
    };
  }
  if (baseAhead > 0) {
    return {
      ...comparedStatus,
      state: "base-ahead",
      message: `${pullRequest.baseBranch} has ${baseAhead} local commit${baseAhead === 1 ? "" : "s"} not on ${upstream}. Push or resolve them before cleanup.`,
    };
  }
  if (baseBehind > 0) {
    return {
      ...comparedStatus,
      state: "base-behind",
      canCleanup: true,
      message: `${pullRequest.baseBranch} has ${baseBehind} incoming commit${baseBehind === 1 ? "" : "s"} from ${upstream}. Cheshi will fast-forward it before deleting the local branch.`,
    };
  }
  return {
    ...comparedStatus,
    state: "ready",
    canCleanup: true,
    message: `${pullRequest.baseBranch} is up to date with ${upstream}. Cheshi can switch branches and delete the local branch.`,
  };
}

export async function getGitHubPullRequestBranchCleanupStatus(context: GitHubPullRequestContext, number: any) {
  const pullRequest = await context.getMergedPullRequestBranchState(number);
  const { snapshot } = await context.fetch();
  return context.inspectPullRequestBranchCleanup(pullRequest, snapshot);
}

export async function cleanupGitHubPullRequestBranch(context: GitHubPullRequestContext, number: any) {
  const pullRequest = await context.getMergedPullRequestBranchState(number);
  const { snapshot } = await context.fetch();
  const status = await context.inspectPullRequestBranchCleanup(
    pullRequest,
    snapshot,
  );
  if (status.state === "complete") {
    return { ...status, output: status.message, updatedBase: false };
  }
  if (!status.canCleanup || !status.upstream) {
    throw new GitCommandError(status.message);
  }

  if (status.currentBranch !== pullRequest.baseBranch) {
    await context.runGit(["switch", pullRequest.baseBranch], {
      timeout: 120_000,
    });
  }
  if (status.baseBehind > 0) {
    await context.runGit(["merge", "--ff-only", status.upstream], {
      timeout: 120_000,
    });
  }
  await context.runGit(["branch", "--delete", pullRequest.branch], {
    timeout: 120_000,
  });
  const nextSnapshot = await context.getSnapshot();
  return {
    ...status,
    currentBranch: pullRequest.baseBranch,
    state: "complete",
    canCleanup: false,
    canPush: false,
    branchAhead: 0,
    baseAhead: 0,
    baseBehind: 0,
    localBranchExists: false,
    message: `Updated ${pullRequest.baseBranch} and deleted the local ${pullRequest.branch} branch.`,
    snapshot: nextSnapshot,
    output: `Updated ${pullRequest.baseBranch} and deleted the local ${pullRequest.branch} branch.`,
    updatedBase: status.baseBehind > 0,
  };
}

export async function deleteGitHubPullRequestBranch(context: GitHubPullRequestContext, number: any) {
  const pullRequest = await context.getMergedPullRequestBranchState(number);

  const { snapshot: currentSnapshot } = await context.fetch();
  if (!currentSnapshot.available) throw new GitCommandError(currentSnapshot.message);
  if (currentSnapshot.changes.length > 0) {
    throw new GitCommandError("Commit or discard the current workspace changes before deleting the pull request branch.");
  }
  const branchReferences = [
    `refs/heads/${pullRequest.branch}`,
    ...currentSnapshot.branches
      .filter((branch) => branch.remote && branch.fullName.replace(/^refs\/remotes\/[^/]+\//u, "") === pullRequest.branch)
      .map((branch) => branch.fullName),
  ];
  for (const reference of branchReferences) {
    if (!(await context.branchReferenceExists(reference))) continue;
    const merged = await context.runGit(
      ["merge-base", "--is-ancestor", reference, pullRequest.headRefOid],
      { acceptedExitCodes: [0, 1, 128] },
    );
    if (merged.exitCode !== 0) {
      throw new GitCommandError(`${pullRequest.branch} contains commits outside the merged pull request. Push any local commits and open a new pull request before deleting the branch.`);
    }
  }

  const result = await context.runGitHub(
    [
      "api",
      `repos/{owner}/{repo}/git/refs/${githubBranchReferencePath(pullRequest.branch)}`,
      "--method",
      "DELETE",
      "--silent",
    ],
    { timeout: 120_000 },
  );

  let snapshot;
  let cleanup = null;
  let refreshWarning = null;
  try {
    snapshot = (await context.fetch()).snapshot;
    cleanup = await context.inspectPullRequestBranchCleanup(
      pullRequest,
      snapshot,
    );
  } catch (error) {
    snapshot = await context.getSnapshot();
    refreshWarning = error instanceof Error ? error.message : String(error);
  }
  return {
    number: pullRequest.number,
    branch: pullRequest.branch,
    baseBranch: pullRequest.baseBranch,
    output:
      result.stderr.trim() ||
      result.stdout.trim() ||
      `Deleted remote branch ${pullRequest.branch}.`,
    refreshWarning,
    cleanup,
    snapshot,
  };
}
