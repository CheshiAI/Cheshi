import { GitCommandError } from "./git-command.mts";
import type { JsonObject } from "./git-types.mts";

const GITHUB_COMMENT_BODY_LIMIT = 65_536;

export const GITHUB_PULL_REQUEST_MERGE_METHODS = new Set([
  "merge",
  "squash",
  "rebase",
]);

const GITHUB_PULL_REQUEST_REVIEW_EVENTS = new Set([
  "APPROVE",
  "COMMENT",
  "REQUEST_CHANGES",
]);

const GITHUB_PULL_REQUEST_REVIEW_MODES = new Set(["comment", "review"]);

const GITHUB_PULL_REQUEST_REVIEW_SIDES = new Set(["LEFT", "RIGHT"]);

const GITHUB_PULL_REQUEST_MERGEABLE_STATES = new Set([
  "MERGEABLE",
  "CONFLICTING",
  "UNKNOWN",
]);

const GITHUB_PULL_REQUEST_MERGE_STATES = new Set([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

const GITHUB_PULL_REQUEST_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);

function isLiteralTrue(value: unknown): value is true {
  return value === true;
}

export function githubUnavailableMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : String(error);
  if (/ENOENT|spawn .* not found/i.test(message)) {
    return "GitHub CLI is not installed. Install gh to manage pull requests.";
  }
  return message || "GitHub pull requests are unavailable.";
}

function pullRequestAuthor(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const loginValue = (value as JsonObject).login;
  const login = typeof loginValue === "string" ? loginValue.trim() : "";
  return login || null;
}

export function assertPullRequestNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Pull request number must be a positive integer.");
  }
  return value;
}

function pullRequestChangedFileCount(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "GitHub pull request changed file count must be a non-negative integer.",
    );
  }
  return value;
}

function requiredPullRequestString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      `GitHub pull request ${fieldName} must be a non-empty string.`,
    );
  }
  return value;
}

export function assertPullRequestList(value: any) {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub CLI returned an invalid pull request list.");
  }
  return value;
}

export function normalizePullRequest(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub pull request entries must be objects.");
  }
  const pullRequest = value as JsonObject;
  if (
    typeof pullRequest.number !== "number" ||
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number < 1
  ) {
    throw new TypeError(
      "GitHub pull request number must be a positive integer.",
    );
  }
  return {
    number: pullRequest.number,
    title: requiredPullRequestString(pullRequest.title, "title"),
    url: githubPullRequestUrl(pullRequest.url, "URL"),
    headRefName: requiredPullRequestString(
      pullRequest.headRefName,
      "head branch",
    ),
    baseRefName: requiredPullRequestString(
      pullRequest.baseRefName,
      "base branch",
    ),
    author: pullRequestAuthor(pullRequest.author),
    updatedAt: requiredPullRequestString(pullRequest.updatedAt, "update time"),
    draft: isLiteralTrue(pullRequest.isDraft),
    reviewDecision:
      typeof pullRequest.reviewDecision === "string" &&
      pullRequest.reviewDecision
        ? pullRequest.reviewDecision
        : null,
    changedFiles: pullRequestChangedFileCount(pullRequest.changedFiles),
  };
}

function pullRequestCommentBody(value: any) {
  if (typeof value !== "string") {
    throw new TypeError("GitHub pull request comment body must be a string.");
  }
  return value;
}

function githubPullRequestUrl(value: any, fieldName: string) {
  const url = requiredPullRequestString(value, fieldName);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com") {
    throw new TypeError(
      `GitHub pull request ${fieldName} must use https://github.com.`,
    );
  }
  return parsedUrl.toString();
}

function normalizePullRequestComment(
  value: {
    id: any;
    author: any;
    body: any;
    createdAt: any;
    url: any;
    viewerDidAuthor: boolean;
  } | null,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub pull request comments must be objects.");
  }
  return {
    id: requiredPullRequestString(value.id, "comment ID"),
    author: pullRequestAuthor(value.author),
    body: pullRequestCommentBody(value.body),
    createdAt: requiredPullRequestString(
      value.createdAt,
      "comment creation time",
    ),
    url: githubPullRequestUrl(value.url, "comment URL"),
    viewerDidAuthor: isLiteralTrue(value.viewerDidAuthor),
  };
}

export function pullRequestNodeId(value: any, fieldName: string) {
  const nodeId = requiredPullRequestString(value, fieldName);
  if (nodeId.length > 512 || /[\0\r\n]/u.test(nodeId)) {
    throw new TypeError(`GitHub pull request ${fieldName} is invalid.`);
  }
  return nodeId;
}

export function pullRequestCommitId(value: any) {
  const commitId = requiredPullRequestString(value, "head commit");
  if (!/^[0-9a-f]{40,64}$/iu.test(commitId)) {
    throw new TypeError(
      "GitHub pull request head commit must be a full object ID.",
    );
  }
  return commitId;
}

function pullRequestReviewSide(value: unknown, fieldName = "review side") {
  if (
    typeof value !== "string" ||
    !GITHUB_PULL_REQUEST_REVIEW_SIDES.has(value)
  ) {
    throw new TypeError(
      `GitHub pull request ${fieldName} must be LEFT or RIGHT.`,
    );
  }
  return value;
}

function pullRequestReviewLine(value: unknown, fieldName = "review line") {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `GitHub pull request ${fieldName} must be a positive integer.`,
    );
  }
  return value;
}

function optionalPullRequestReviewLine(value: unknown, fieldName?: string) {
  return value === null ? null : pullRequestReviewLine(value, fieldName);
}

function pullRequestReviewPath(value: any) {
  const filePath = requiredPullRequestString(value, "review path").replaceAll(
    "\\",
    "/",
  );
  if (
    filePath.startsWith("/") ||
    filePath.split("/").includes("..") ||
    /[\0\r\n]/u.test(filePath)
  ) {
    throw new TypeError(
      "GitHub pull request review path must be repository-relative.",
    );
  }
  return filePath;
}

function githubGraphQLObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`GitHub ${label} must be an object.`);
  }
  return value as JsonObject;
}

function githubGraphQLNodes(value: unknown, label: string): unknown[] {
  const connection = githubGraphQLObject(value, `${label} connection`);
  if (!Array.isArray(connection.nodes)) {
    throw new TypeError(`GitHub ${label} connection must contain nodes.`);
  }
  return connection.nodes.filter((entry) => entry !== null);
}

function normalizePullRequestReviewComment(value: any) {
  const comment = githubGraphQLObject(value, "pull request review comment");
  if (comment.state !== "PENDING" && comment.state !== "SUBMITTED") {
    throw new TypeError("GitHub pull request review comment state is invalid.");
  }
  return {
    id: pullRequestNodeId(comment.id, "review comment ID"),
    author: pullRequestAuthor(comment.author),
    body: pullRequestCommentBody(comment.body),
    createdAt: requiredPullRequestString(
      comment.createdAt,
      "review comment creation time",
    ),
    url: githubPullRequestUrl(comment.url, "review comment URL"),
    viewerDidAuthor: isLiteralTrue(comment.viewerDidAuthor),
    pending: comment.state === "PENDING",
  };
}

function normalizePullRequestReviewThread(value: any) {
  const thread = githubGraphQLObject(value, "pull request review thread");
  const subjectType = thread.subjectType;
  if (subjectType !== "FILE" && subjectType !== "LINE") {
    throw new TypeError(
      "GitHub pull request review thread subject type is invalid.",
    );
  }
  const startSide =
    thread.startDiffSide === null
      ? null
      : pullRequestReviewSide(thread.startDiffSide, "review start side");
  return {
    id: pullRequestNodeId(thread.id, "review thread ID"),
    path: pullRequestReviewPath(thread.path),
    line: optionalPullRequestReviewLine(thread.line, "review line"),
    startLine: optionalPullRequestReviewLine(
      thread.startLine,
      "review start line",
    ),
    side: pullRequestReviewSide(thread.diffSide),
    startSide,
    subjectType,
    resolved: thread.isResolved === true,
    outdated: thread.isOutdated === true,
    comments: githubGraphQLNodes(
      thread.comments,
      "pull request review comments",
    ).map(normalizePullRequestReviewComment),
  };
}

function normalizePullRequestPendingReview(value: any, viewerLogin: string) {
  const reviews = githubGraphQLNodes(value, "pull request reviews");
  const pendingReview = reviews.find((entry: any) => {
    const review = githubGraphQLObject(entry, "pull request review");
    return (
      review.state === "PENDING" &&
      pullRequestAuthor(review.author) === viewerLogin
    );
  });
  if (!pendingReview) return null;
  const review = githubGraphQLObject(
    pendingReview,
    "pull request pending review",
  );
  const comments = githubGraphQLObject(
    review.comments,
    "pull request pending review comments",
  );
  if (
    typeof comments.totalCount !== "number" ||
    !Number.isSafeInteger(comments.totalCount) ||
    comments.totalCount < 0
  ) {
    throw new TypeError(
      "GitHub pull request pending review comment count must be a non-negative integer.",
    );
  }
  return {
    id: pullRequestNodeId(review.id, "pending review ID"),
    commentCount: comments.totalCount,
  };
}

export function normalizePullRequestReviewData(value: any, pullRequestId: string) {
  const response = githubGraphQLObject(value, "pull request review response");
  const data = githubGraphQLObject(
    response.data,
    "pull request review response data",
  );
  const node = githubGraphQLObject(
    data.node,
    "pull request review response node",
  );
  if (pullRequestNodeId(node.id, "ID") !== pullRequestId) {
    throw new TypeError(
      "GitHub pull request review response does not match the selected pull request.",
    );
  }
  const viewer = githubGraphQLObject(data.viewer, "viewer");
  const viewerLogin = requiredPullRequestString(viewer.login, "viewer login");
  return {
    viewerLogin,
    reviewThreads: githubGraphQLNodes(
      node.reviewThreads,
      "pull request review threads",
    ).map(normalizePullRequestReviewThread),
    pendingReview: normalizePullRequestPendingReview(node.reviews, viewerLogin),
  };
}

function pullRequestCommitAuthors(value: any[]) {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub pull request commit authors must be an array.");
  }
  return value.map((author) => {
    if (
      typeof author !== "object" ||
      author === null ||
      Array.isArray(author)
    ) {
      throw new TypeError(
        "GitHub pull request commit authors must be objects.",
      );
    }
    const login = typeof author.login === "string" ? author.login.trim() : "";
    const name = typeof author.name === "string" ? author.name.trim() : "";
    const email = typeof author.email === "string" ? author.email.trim() : "";
    const label = login || name || email;
    if (!label)
      throw new TypeError(
        "GitHub pull request commit author must have an identity.",
      );
    return label;
  });
}

function normalizePullRequestCommit(
  value: {
    oid: any;
    messageHeadline: any;
    messageBody: any;
    authoredDate: any;
    authors: any;
  } | null,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub pull request commits must be objects.");
  }
  const oid = requiredPullRequestString(value.oid, "commit object ID");
  if (!/^[0-9a-f]{40,64}$/iu.test(oid)) {
    throw new TypeError(
      "GitHub pull request commit object ID must be a full object ID.",
    );
  }
  return {
    oid,
    headline: requiredPullRequestString(
      value.messageHeadline,
      "commit headline",
    ),
    body: typeof value.messageBody === "string" ? value.messageBody : "",
    authoredAt: requiredPullRequestString(
      value.authoredDate,
      "commit author time",
    ),
    authors: pullRequestCommitAuthors(value.authors),
  };
}

export function normalizePullRequestDetails(
  value: { comments: any[]; commits: any[]; id: any; headRefOid: any } | null,
  reviewData: {
    viewerLogin: string;
    reviewThreads: any;
    pendingReview: { id: string; commentCount: any } | null;
  },
  number: any,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub pull request details must be an object.");
  }
  if (!Array.isArray(value.comments) || !Array.isArray(value.commits)) {
    throw new TypeError(
      "GitHub pull request details must contain comments and commits.",
    );
  }
  return {
    number: assertPullRequestNumber(number),
    id: pullRequestNodeId(value.id, "ID"),
    headRefOid: pullRequestCommitId(value.headRefOid),
    comments: value.comments.map(normalizePullRequestComment),
    commits: value.commits.map(normalizePullRequestCommit),
    ...reviewData,
  };
}

export function normalizePullRequestCommentRequest(
  request: { body: string; number: any } | null,
) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new TypeError("Pull request comment request must be an object.");
  }
  const body = typeof request.body === "string" ? request.body.trim() : "";
  if (!body || body.length > GITHUB_COMMENT_BODY_LIMIT) {
    throw new TypeError(
      `Pull request comment must be between 1 and ${GITHUB_COMMENT_BODY_LIMIT} characters.`,
    );
  }
  return { number: assertPullRequestNumber(request.number), body };
}

export function normalizePullRequestReviewCommentRequest(
  request: {
    body: string;
    mode: string;
    pendingReviewId: null;
    number: any;
    pullRequestId: any;
    commitId: any;
    path: any;
    line: any;
    side: any;
  } | null,
) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new TypeError(
      "Pull request review comment request must be an object.",
    );
  }
  const body = typeof request.body === "string" ? request.body.trim() : "";
  if (!body || body.length > GITHUB_COMMENT_BODY_LIMIT) {
    throw new TypeError(
      `Pull request review comment must be between 1 and ${GITHUB_COMMENT_BODY_LIMIT} characters.`,
    );
  }
  if (!GITHUB_PULL_REQUEST_REVIEW_MODES.has(request.mode)) {
    throw new TypeError("Pull request review comment mode is invalid.");
  }
  const pendingReviewId =
    request.pendingReviewId === null
      ? null
      : pullRequestNodeId(request.pendingReviewId, "pending review ID");
  if (request.mode === "comment" && pendingReviewId !== null) {
    throw new TypeError(
      "A single pull request review comment cannot target a pending review.",
    );
  }
  return {
    number: assertPullRequestNumber(request.number),
    pullRequestId: pullRequestNodeId(request.pullRequestId, "ID"),
    commitId: pullRequestCommitId(request.commitId),
    path: pullRequestReviewPath(request.path),
    line: pullRequestReviewLine(request.line),
    side: pullRequestReviewSide(request.side),
    body,
    mode: request.mode,
    pendingReviewId,
  };
}

export function normalizePullRequestReviewSubmissionRequest(
  request: { event: string; number: any; reviewId: any } | null,
) {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new TypeError(
      "Pull request review submission request must be an object.",
    );
  }
  if (!GITHUB_PULL_REQUEST_REVIEW_EVENTS.has(request.event)) {
    throw new TypeError("Pull request review event is invalid.");
  }
  return {
    number: assertPullRequestNumber(request.number),
    reviewId: pullRequestNodeId(request.reviewId, "pending review ID"),
    event: request.event,
  };
}

export function normalizePullRequestMergeState(
  value: {
    headRefOid: string;
    isDraft: boolean;
    mergeable: string;
    mergeStateStatus: string;
    headRefName: any;
    baseRefName: any;
    isCrossRepository: boolean;
  } | null,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub pull request merge state must be an object.");
  }
  const headRefOid =
    typeof value.headRefOid === "string" ? value.headRefOid.trim() : "";
  if (!/^[0-9a-f]{40,64}$/iu.test(headRefOid)) {
    throw new TypeError(
      "GitHub pull request head commit must be a full object id.",
    );
  }
  if (typeof value.isDraft !== "boolean") {
    throw new TypeError("GitHub pull request draft state must be a boolean.");
  }
  if (!GITHUB_PULL_REQUEST_MERGEABLE_STATES.has(value.mergeable)) {
    throw new TypeError("GitHub pull request mergeability is invalid.");
  }
  if (!GITHUB_PULL_REQUEST_MERGE_STATES.has(value.mergeStateStatus)) {
    throw new TypeError("GitHub pull request merge state is invalid.");
  }
  const headRefName = requiredPullRequestString(
    value.headRefName,
    "head branch",
  ).trim();
  const baseRefName = requiredPullRequestString(
    value.baseRefName,
    "base branch",
  ).trim();
  if (typeof value.isCrossRepository !== "boolean") {
    throw new TypeError(
      "GitHub pull request cross-repository state must be a boolean.",
    );
  }
  return {
    headRefOid,
    headRefName,
    baseRefName,
    draft: value.isDraft,
    crossRepository: value.isCrossRepository,
    mergeable: value.mergeable,
    mergeStateStatus: value.mergeStateStatus,
  };
}

export function normalizePullRequestBranchDeletionState(
  value: {
    state: string;
    isCrossRepository: boolean;
    headRefOid: any;
    headRefName: any;
    baseRefName: any;
  } | null,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub pull request branch state must be an object.");
  }
  if (!GITHUB_PULL_REQUEST_STATES.has(value.state)) {
    throw new TypeError("GitHub pull request state is invalid.");
  }
  if (typeof value.isCrossRepository !== "boolean") {
    throw new TypeError(
      "GitHub pull request cross-repository state must be a boolean.",
    );
  }
  return {
    state: value.state,
    headRefOid: pullRequestCommitId(value.headRefOid),
    headRefName: requiredPullRequestString(
      value.headRefName,
      "head branch",
    ).trim(),
    baseRefName: requiredPullRequestString(
      value.baseRefName,
      "base branch",
    ).trim(),
    crossRepository: value.isCrossRepository,
  };
}

/**
 * @param {string} branchName
 * @returns {string}
 */
export function githubBranchReferencePath(branchName: string): string {
  return [
    "heads",
    ...branchName.split("/").map((component) => encodeURIComponent(component)),
  ].join("/");
}

export function assertPullRequestCanMerge(state: {
  headRefOid?: any;
  headRefName?: string;
  baseRefName?: string;
  draft: any;
  crossRepository?: boolean;
  mergeable: any;
  mergeStateStatus: any;
}) {
  if (state.draft || state.mergeStateStatus === "DRAFT") {
    throw new GitCommandError("Draft pull requests cannot be merged.");
  }
  if (state.mergeable === "CONFLICTING" || state.mergeStateStatus === "DIRTY") {
    throw new GitCommandError(
      "Resolve merge conflicts before merging this pull request.",
    );
  }
  if (state.mergeable === "UNKNOWN" || state.mergeStateStatus === "UNKNOWN") {
    throw new GitCommandError(
      "GitHub is still calculating whether this pull request can be merged. Try again shortly.",
    );
  }
  if (state.mergeStateStatus === "BLOCKED") {
    throw new GitCommandError(
      "Required reviews or checks are blocking this pull request.",
    );
  }
  if (state.mergeStateStatus === "BEHIND") {
    throw new GitCommandError(
      "Update this pull request with the latest base branch before merging.",
    );
  }
  if (state.mergeStateStatus === "UNSTABLE") {
    throw new GitCommandError(
      "Status checks are failing for this pull request.",
    );
  }
}
