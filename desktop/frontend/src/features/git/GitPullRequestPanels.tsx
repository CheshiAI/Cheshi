import {
  AlertTriangle,
  Check,
  GitMerge,
  LoaderCircle,
  Trash2,
  Upload,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import { EmptyState, LoadingState, NeumorphicButton } from '../../shared/ui';
import type { GitHubPullRequestReviewThread } from '../../cheshiDesktop';
import {
  formatGitDate,
  type MergedPullRequestState,
  type PullRequestDetailTab,
} from './gitWorkspaceModel';
import styles from './GitWorkspace.module.css';

interface PullRequestCommentCardProps {
  author: string | null;
  body: string;
  createdAt: string;
  pending?: boolean;
  resolved?: boolean;
  viewerDidAuthor: boolean;
  compact?: boolean;
}

export function PullRequestCommentCard({
  author,
  body,
  createdAt,
  pending = false,
  resolved = false,
  viewerDidAuthor,
  compact = false,
}: PullRequestCommentCardProps) {
  return (
    <article className={`${styles.pullRequestComment}${compact ? ` ${styles.inlineReviewComment}` : ''}`}>
      <header className={styles.pullRequestCommentHeader}>
        <span>
          <UserRound aria-hidden="true" />
          <strong>{author ?? 'Unknown'}</strong>
          {viewerDidAuthor && <em className={styles.pullRequestCommentBadge}>You</em>}
          {pending && <em className={styles.pullRequestCommentBadge} data-kind="pending">Pending</em>}
          {resolved && <em className={styles.pullRequestCommentBadge} data-kind="resolved">Resolved</em>}
        </span>
        <time dateTime={createdAt}>{formatGitDate(createdAt)}</time>
      </header>
      <p>{body}</p>
    </article>
  );
}

export function PullRequestReviewThread({ thread }: { thread: GitHubPullRequestReviewThread }) {
  return (
    <section
      aria-label={`Review comments on ${thread.path} line ${thread.line ?? 'outdated'}`}
      className={styles.inlineReviewThread}
    >
      {thread.comments.map((comment, index) => (
        <PullRequestCommentCard
          author={comment.author}
          body={comment.body}
          compact
          createdAt={comment.createdAt}
          key={comment.id}
          pending={comment.pending}
          resolved={thread.resolved && index === 0}
          viewerDidAuthor={comment.viewerDidAuthor}
        />
      ))}
    </section>
  );
}

export function MarkedPanelTitle({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className={`${styles.panelTitle} ${styles.markedPanelTitle}`}>
      <NeumorphicButton
        raised
        aria-hidden="true"
        className={`theme-toggle ${styles.panelTitleMark}`}
        disabled
      >
        <Icon />
      </NeumorphicButton>
      <strong>{title}</strong>
    </div>
  );
}

type PullRequestActivityStateKind = 'loading' | PullRequestDetailTab;

export function PullRequestActivityState({ kind }: { kind: PullRequestActivityStateKind }) {
  if (kind === 'loading') {
    return <LoadingState className={styles.loadingState} />;
  }

  if (kind === 'conversation') {
    return (
      <EmptyState
        className={styles.pullRequestCommentsEmpty}
        title="No comments yet."
        description="Comments from GitHub will appear here."
      />
    );
  }

  const message = kind === 'commits'
    ? 'No commits were returned for this pull request.'
    : 'No pushed file changes were returned for this pull request.';

  return (
    <div className={`${styles.emptyState} ${styles.pullRequestActivityEmpty}`}>
      <span>{message}</span>
    </div>
  );
}

interface MergedPullRequestDetailProps {
  busy: boolean;
  checkingCleanup: boolean;
  cleaningBranch: boolean;
  deletingBranch: boolean;
  pushingBranch: boolean;
  hasLocalChanges: boolean;
  mergedPullRequest: MergedPullRequestState;
  onCleanupBranch: () => void;
  onDeleteBranch: () => void;
  onPushBranch: () => void;
}

export function MergedPullRequestDetail({
  busy,
  checkingCleanup,
  cleaningBranch,
  deletingBranch,
  pushingBranch,
  hasLocalChanges,
  mergedPullRequest,
  onCleanupBranch,
  onDeleteBranch,
  onPushBranch,
}: MergedPullRequestDetailProps) {
  const { pullRequest } = mergedPullRequest;
  const cleanup = mergedPullRequest.cleanup;
  const cleanupBlocked = mergedPullRequest.branchDeleted
    && !checkingCleanup
    && (
      mergedPullRequest.cleanupError !== null
      || (
        cleanup !== null
        && cleanup.state !== 'complete'
        && !cleanup.canCleanup
        && !cleanup.canPush
      )
    );
  const canDeleteRemote = !checkingCleanup && !hasLocalChanges
    && mergedPullRequest.cleanupError === null
    && (cleanup?.state === 'remote-branch-present' || cleanup?.state === 'complete');
  const remoteStatus = checkingCleanup || cleanup === null
    ? 'Checking branch changes…'
    : hasLocalChanges
      ? 'Commit or discard local changes before deleting this branch.'
      : cleanup.message;
  const cleanupActionLabel = cleanup?.state === 'base-behind'
    ? `Update ${cleanup.baseBranch} and delete local branch`
    : 'Switch and delete local branch';

  return (
    <>
      <header className={`${styles.panelHeader} ${styles.pullRequestDetailHeader}`}>
        <MarkedPanelTitle icon={GitMerge} title={`Pull request #${pullRequest.number}`} />
        <span className={styles.pullRequestState} data-state="merged">
          <Check aria-hidden="true" />
          Merged
        </span>
      </header>
      <div className={styles.pullRequestMergedBody}>
        <section
          aria-labelledby={`merged-pull-request-${pullRequest.number}`}
          className={styles.pullRequestMergedCard}
        >
          <div className={styles.pullRequestMergedHeading}>
            <span className={styles.pullRequestMergedMark} aria-hidden="true">
              <GitMerge />
            </span>
            <div className={styles.pullRequestMergedCopy}>
              <h2 id={`merged-pull-request-${pullRequest.number}`}>
                Pull request successfully merged and closed
              </h2>
              <p>
                {mergedPullRequest.branchDeleted ? (
                  <>The remote <code>{pullRequest.headRefName}</code> branch was deleted.</>
                ) : (
                  <>The changes from this pull request were merged. Check any remaining work on <code>{pullRequest.headRefName}</code> before deleting it.</>
                )}
              </p>
            </div>
          </div>
          <div className={styles.pullRequestMergedFooter}>
            {cleanup?.canPush === true ? (
              <>
                <small>{mergedPullRequest.cleanupError ?? cleanup.message}</small>
                <NeumorphicButton
                  size="standard"
                  raised
                  aria-busy={pushingBranch}
                  className="neumorphic-surface"
                  disabled={busy || checkingCleanup || mergedPullRequest.cleanupError !== null}
                  onClick={onPushBranch}
                >
                  {pushingBranch ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <Upload aria-hidden="true" />}
                  {pushingBranch ? 'Pushing…' : `Push ${cleanup.branch}`}
                </NeumorphicButton>
              </>
            ) : mergedPullRequest.branchDeleted ? (
              <>
                <div className={styles.pullRequestMergedCleanupCopy}>
                  <span className={styles.pullRequestMergedStatus} role="status">
                    <Check aria-hidden="true" />
                    Remote branch deleted
                  </span>
                  <small>
                    {checkingCleanup
                      ? 'Checking the local branch and remote main status…'
                      : mergedPullRequest.cleanupError
                        ?? cleanup?.message
                        ?? 'The local branch remains available in Cheshi.'}
                  </small>
                </div>
                {cleanup?.canCleanup === true ? (
                  <NeumorphicButton
                    size="standard"
                    raised
                    aria-busy={cleaningBranch}
                    className="neumorphic-surface"
                    disabled={busy || checkingCleanup}
                    onClick={onCleanupBranch}
                  >
                    {cleaningBranch ? (
                      <LoaderCircle className={styles.spinner} aria-hidden="true" />
                    ) : (
                      <Trash2 aria-hidden="true" />
                    )}
                    {cleaningBranch ? 'Cleaning up…' : cleanupActionLabel}
                  </NeumorphicButton>
                ) : cleanupBlocked ? (
                  <span className={styles.pullRequestMergedBlocked} role="status">
                    <AlertTriangle aria-hidden="true" />
                    Action required
                  </span>
                ) : null}
              </>
            ) : mergedPullRequest.branchDeletionAvailable ? (
              <>
                <small>{mergedPullRequest.cleanupError ?? remoteStatus}</small>
                <NeumorphicButton
                  size="standard"
                  raised
                  aria-busy={deletingBranch}
                  className="neumorphic-surface"
                  disabled={busy || !canDeleteRemote}
                  onClick={onDeleteBranch}
                >
                  {deletingBranch ? (
                    <LoaderCircle className={styles.spinner} aria-hidden="true" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                  {deletingBranch ? 'Deleting…' : 'Delete branch'}
                </NeumorphicButton>
              </>
            ) : (
              <span className={styles.pullRequestMergedUnavailable}>
                This branch belongs to another repository and must be managed there.
              </span>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
