import type { CSSProperties } from 'react';

import type {
  GitDiffRequest,
  GitFileChange,
  GitHubPullRequestBranchCleanupStatus,
  GitHubPullRequestListResult,
  GitHubPullRequestMergeMethod,
  GitHubPullRequestReviewEvent,
  GitHubPullRequestReviewSide,
  GitHubPullRequestSummary,
  GitMutationResult,
  GitRepositorySnapshot,
} from '../../cheshiDesktop';
import type { UnifiedDiffFile, UnifiedDiffLine } from './unifiedDiff';

export type GitWorkspaceTab = 'changes' | 'log' | 'pull-requests' | 'issues';
export type PullRequestDetailTab = 'conversation' | 'commits' | 'changes';
export type GitMutationOutcome = GitRepositorySnapshot | GitMutationResult;
export type GitMutationSuccessMessage = string | ((result: GitMutationOutcome) => string);
export type GitRefreshMode = 'foreground' | 'background';
export type PullRequestOperation = 'push' | 'create' | 'merge' | 'delete-branch' | 'cleanup-branch' | null;

export interface MergedPullRequestState {
  pullRequest: GitHubPullRequestSummary;
  branchDeletionAvailable: boolean;
  branchDeleted: boolean;
  cleanup: GitHubPullRequestBranchCleanupStatus | null;
  cleanupError: string | null;
}

export interface PullRequestReviewLocation {
  path: string;
  line: number;
  side: GitHubPullRequestReviewSide;
}

export const GITHUB_COMMENT_BODY_LIMIT = 65_536;
export const GIT_REMOTE_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const MINIMUM_LOADING_FEEDBACK_MS = 400;

const gitDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

export const EMPTY_SNAPSHOT: GitRepositorySnapshot = {
  available: false,
  message: '',
  changes: [],
  branches: [],
  commits: [],
};

export const EMPTY_PULL_REQUESTS: GitHubPullRequestListResult = {
  available: false,
  message: '',
  pullRequests: [],
};

export const PULL_REQUEST_DETAIL_STYLE: CSSProperties = {
  backgroundColor: 'var(--app-bg)',
  backgroundImage: 'none',
};

export const gitWorkspaceTabs: Array<{ id: GitWorkspaceTab; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'issues', label: 'Issues' },
  { id: 'log', label: 'Branches & Log' },
  { id: 'pull-requests', label: 'Push & Pull requests' },
];

export const pullRequestMergeMethods: ReadonlyArray<{
  label: string;
  value: GitHubPullRequestMergeMethod;
}> = [
  { label: 'Merge commit', value: 'merge' },
  { label: 'Squash and merge', value: 'squash' },
  { label: 'Rebase and merge', value: 'rebase' },
];

export const pullRequestReviewEvents: ReadonlyArray<{
  label: string;
  value: GitHubPullRequestReviewEvent;
}> = [
  { label: 'Comment', value: 'COMMENT' },
  { label: 'Approve', value: 'APPROVE' },
  { label: 'Request changes', value: 'REQUEST_CHANGES' },
];

export function changeScope(change: GitFileChange): GitDiffRequest['scope'] {
  return change.unstaged ? 'working' : 'staged';
}

export function changeStatus(change: GitFileChange): string {
  if (change.untracked) return 'U';
  if (change.indexStatus === 'A' || change.workingTreeStatus === 'A') return 'A';
  if (change.indexStatus === 'D' || change.workingTreeStatus === 'D') return 'D';
  if (change.indexStatus === 'R' || change.workingTreeStatus === 'R') return 'R';
  return 'M';
}

export function formatGitDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : gitDateTimeFormatter.format(date);
}

export function reviewDecisionLabel(value: string | null): string {
  switch (value) {
    case 'APPROVED': return 'Approved';
    case 'CHANGES_REQUESTED': return 'Changes requested';
    case 'REVIEW_REQUIRED': return 'Review required';
    default: return value || 'Pending';
  }
}

export function sameGitDiffRequest(
  left: GitDiffRequest | null,
  right: GitDiffRequest | null,
): boolean {
  return left?.scope === right?.scope
    && left?.path === right?.path
    && left?.commit === right?.commit;
}

export async function waitForMinimumLoadingFeedback(startedAt: number): Promise<void> {
  const remaining = MINIMUM_LOADING_FEEDBACK_MS - (performance.now() - startedAt);
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

export function snapshotFingerprint(snapshot: GitRepositorySnapshot): string {
  return JSON.stringify(snapshot);
}

export function pullRequestReviewLocation(
  file: UnifiedDiffFile,
  line: UnifiedDiffLine,
): PullRequestReviewLocation | null {
  if (line.kind === 'deletion' && line.oldLine !== null) {
    return { path: file.path, line: line.oldLine, side: 'LEFT' };
  }
  if ((line.kind === 'addition' || line.kind === 'context') && line.newLine !== null) {
    return { path: file.path, line: line.newLine, side: 'RIGHT' };
  }
  return null;
}

export function pullRequestReviewLocationKey(location: PullRequestReviewLocation): string {
  return `${location.path}\0${location.side}\0${location.line}`;
}
