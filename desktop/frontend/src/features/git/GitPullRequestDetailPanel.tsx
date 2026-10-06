import {
  ArrowRight,
  CircleDot,
  Clock3,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquareText,
  Send,
  Upload,
  UserRound,
} from 'lucide-react';

import {
  EmptyState,
  FilterTab,
  FilterTabList,
  LiquidGlassPanel,
  LiquidGlassSelect,
  NeumorphicButton,
  NeumorphicTextField,
} from '../../shared/ui';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { GitDiffViewer } from './GitDiffViewer';
import {
  GITHUB_COMMENT_BODY_LIMIT,
  formatGitDate,
  pullRequestMergeMethods,
  reviewDecisionLabel,
} from './gitWorkspaceModel';
import {
  MergedPullRequestDetail,
  PullRequestActivityState,
  PullRequestCommentCard,
} from './GitPullRequestPanels';
import styles from './GitWorkspace.module.css';
import type { GitWorkspaceController } from './useGitWorkspaceController';

export function GitPullRequestDetailPanel({ controller, onOpenWorkspaceFile }: {
  controller: GitWorkspaceController;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  const {
    addPullRequestComment,
    addPullRequestReviewComment,
    beginMerge,
    busy,
    checkoutPullRequest,
    cleanupMergedPullRequestBranch,
    deleteMergedPullRequestBranch,
    mergeConfirmationNumber,
    mergeMethod,
    mergePullRequest,
    mergedPullRequest,
    openPullRequest,
    pullRequestCleanupChecking,
    pullRequestComment,
    pullRequestCommentSubmitting,
    pullRequestDetails,
    pullRequestDetailsLoading,
    pullRequestDetailTab,
    pullRequestDiff,
    pullRequestDiffError,
    pullRequestDiffFiles,
    pullRequestDiffLoading,
    pullRequestOperation,
    pullRequestReviewSubmitting,
    pullRequestsLoading,
    pushCurrentBranch,
    pushMergedPullRequestBranch,
    selectedPullRequest,
    selectedPullRequestCommit,
    selectedPullRequestDiffPath,
    selectedPullRequestNeedsPush,
    selectPullRequestCommit,
    setMergeConfirmationNumber,
    setMergeMethod,
    setPullRequestComment,
    setPullRequestDetailTab,
    setSelectedPullRequestDiffPath,
    submitPullRequestReview,
  } = controller;
  const activityLoading = pullRequestsLoading || pullRequestDetailsLoading;
  const commitsNewestFirst = [...(pullRequestDetails?.commits ?? [])].sort(
    (left, right) => Date.parse(right.authoredAt) - Date.parse(left.authoredAt),
  );

  return (
    <LiquidGlassPanel
      as="section"
      aria-label="Pull request detail"
      className={styles.pullRequestDetail}
      data-liquid-glass-surface="side-panel"
      role="region"
    >
      {selectedPullRequest ? (
        <>
          <header className={`${styles.panelHeader} ${styles.pullRequestDetailHeader}`}>
            <SidebarPanelTitle
              icon={<GitPullRequest aria-hidden="true" />}
              title={`PULL REQUEST #${selectedPullRequest.number}`}
            />
            <span
              className={styles.pullRequestState}
              data-state={selectedPullRequest.draft ? 'draft' : 'open'}
            >
              <CircleDot aria-hidden="true" />
              {selectedPullRequest.draft ? 'Draft' : 'Open'}
            </span>
          </header>
          <section
            aria-label="Pull request details"
            className={styles.pullRequestBody}
            role="region"
          >
            <section
              aria-labelledby={`pull-request-title-${selectedPullRequest.number}`}
              className={styles.pullRequestOverview}
            >
              <div className={styles.pullRequestOverviewHeading}>
                <span>Overview</span>
                <h2 id={`pull-request-title-${selectedPullRequest.number}`}>
                  {selectedPullRequest.title}
                </h2>
              </div>
              <div
                aria-label={`Pull request from ${selectedPullRequest.headRefName} into ${selectedPullRequest.baseRefName}`}
                className={styles.pullRequestBranchFlow}
              >
                <span className={styles.pullRequestBranchRef} data-kind="head">
                  <GitBranch aria-hidden="true" />
                  <code>{selectedPullRequest.headRefName}</code>
                </span>
                <ArrowRight aria-hidden="true" />
                <span className={`${styles.pullRequestBranchRef} ${styles.changeCountBadge}`} data-kind="base">
                  <code>{selectedPullRequest.baseRefName}</code>
                </span>
              </div>
              <dl aria-label="Pull request metadata">
                <div>
                  <dt><UserRound aria-hidden="true" />Author</dt>
                  <dd>{selectedPullRequest.author ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt><Clock3 aria-hidden="true" />Updated</dt>
                  <dd>{formatGitDate(selectedPullRequest.updatedAt)}</dd>
                </div>
                <div>
                  <dt><GitPullRequest aria-hidden="true" />Review</dt>
                  <dd>
                    <span
                      className={styles.pullRequestReview}
                      data-state={selectedPullRequest.reviewDecision?.toLowerCase() ?? 'pending'}
                    >
                      {reviewDecisionLabel(selectedPullRequest.reviewDecision)}
                    </span>
                  </dd>
                </div>
              </dl>
            </section>
            <header className={styles.pullRequestActivityHeader}>
              <SidebarPanelTitle
                icon={pullRequestDetailTab === 'conversation'
                  ? <MessageSquareText aria-hidden="true" />
                  : pullRequestDetailTab === 'commits'
                    ? <GitCommitHorizontal aria-hidden="true" />
                    : <FileText aria-hidden="true" />}
                title="ACTIVITY"
              />
              <FilterTabList
                as="nav"
                aria-label="Pull request content"
                className={styles.pullRequestDetailTabs}
              >
                <FilterTab
                  active={pullRequestDetailTab === 'conversation'}
                  aria-current={pullRequestDetailTab === 'conversation' ? 'page' : undefined}
                  badge={pullRequestDetails?.comments.length || undefined}
                  onClick={() => setPullRequestDetailTab('conversation')}
                >
                  Conversation
                </FilterTab>
                <FilterTab
                  active={pullRequestDetailTab === 'commits'}
                  aria-current={pullRequestDetailTab === 'commits' ? 'page' : undefined}
                  badge={pullRequestDetails?.commits.length || undefined}
                  onClick={() => setPullRequestDetailTab('commits')}
                >
                  Commits
                </FilterTab>
                <FilterTab
                  active={pullRequestDetailTab === 'changes'}
                  aria-current={pullRequestDetailTab === 'changes' ? 'page' : undefined}
                  badge={pullRequestDiff ? pullRequestDiffFiles.length : undefined}
                  onClick={() => setPullRequestDetailTab('changes')}
                >
                  Changes
                </FilterTab>
              </FilterTabList>
            </header>
            <section
              aria-busy={pullRequestDetailTab === 'changes'
                ? pullRequestDiffLoading
                : activityLoading}
              aria-label={pullRequestDetailTab === 'conversation'
                ? 'Pull request conversation'
                : pullRequestDetailTab === 'commits'
                  ? 'Pull request commits'
                  : 'Pull request changes'}
              className={styles.pullRequestActivity}
              data-tab={pullRequestDetailTab}
            >
              {mergeConfirmationNumber === selectedPullRequest.number && (
                <LiquidGlassPanel
                  as="section"
                  aria-labelledby={`merge-pull-request-${selectedPullRequest.number}`}
                  className={styles.mergeConfirmation}
                  role="dialog"
                >
                  <strong id={`merge-pull-request-${selectedPullRequest.number}`}>
                    Merge pull request #{selectedPullRequest.number}?
                  </strong>
                  <span>
                    {selectedPullRequest.headRefName} will be merged into {selectedPullRequest.baseRefName}.
                    GitHub reviews, checks, and conflicts will be verified before merging.
                  </span>
                  <form
                    className={styles.pullRequestCommentForm}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addPullRequestComment();
                    }}
                  >
                    <label htmlFor={`pull-request-comment-${selectedPullRequest.number}`}>Add comment</label>
                    <NeumorphicTextField
                      variant="standard"
                      multiline
                      aria-label="Pull request comment"
                      className={styles.pullRequestCommentInput}
                      disabled={pullRequestCommentSubmitting}
                      id={`pull-request-comment-${selectedPullRequest.number}`}
                      maxLength={GITHUB_COMMENT_BODY_LIMIT}
                      placeholder="Leave a comment"
                      rows={4}
                      value={pullRequestComment}
                      onChange={(event) => setPullRequestComment(event.target.value)}
                    />
                    <div className={styles.pullRequestCommentFooter}>
                      <span>
                        {pullRequestComment.length > 0
                          ? `${pullRequestComment.length.toLocaleString()} characters`
                          : 'Markdown is supported by GitHub.'}
                      </span>
                      <NeumorphicButton
                        variant="standard"
                        aria-busy={pullRequestCommentSubmitting}
                        disabled={pullRequestCommentSubmitting || !pullRequestComment.trim()}
                        type="submit"
                      >
                        {pullRequestCommentSubmitting ? (
                          <LoaderCircle className={styles.spinner} aria-hidden="true" />
                        ) : (
                          <Send aria-hidden="true" />
                        )}
                        Comment
                      </NeumorphicButton>
                    </div>
                  </form>
                  <div className={styles.mergeConfirmationControls}>
                    <LiquidGlassSelect
                      triggerAppearance="standard"
                      menuAppearance="toolbar"
                      ariaLabel="Merge method"
                      disabled={busy}
                      menuLabel="Pull request merge method"
                      onChange={setMergeMethod}
                      options={pullRequestMergeMethods}
                      value={mergeMethod}
                    />
                    <div className={styles.mergeConfirmationActions}>
                      <NeumorphicButton
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setMergeConfirmationNumber(null)}
                      >
                        Cancel
                      </NeumorphicButton>
                      <NeumorphicButton
                        variant="standard"
                        aria-busy={pullRequestOperation === 'merge'}
                        disabled={busy || pullRequestCommentSubmitting}
                        onClick={() => void mergePullRequest()}
                      >
                        {pullRequestOperation === 'merge' && (
                          <LoaderCircle className={styles.spinner} aria-hidden="true" />
                        )}
                        Merge pull request
                      </NeumorphicButton>
                    </div>
                  </div>
                </LiquidGlassPanel>
              )}
              {pullRequestDetailTab !== 'changes' && activityLoading && !pullRequestDetails ? (
                <PullRequestActivityState kind="loading" />
              ) : pullRequestDetailTab === 'conversation' ? (
                <div className={styles.pullRequestComments}>
                  {(pullRequestDetails?.comments ?? []).map((comment) => (
                    <PullRequestCommentCard
                      author={comment.author}
                      body={comment.body}
                      createdAt={comment.createdAt}
                      key={comment.id}
                      viewerDidAuthor={comment.viewerDidAuthor}
                    />
                  ))}
                  {(pullRequestDetails?.comments.length ?? 0) === 0 && (
                    <PullRequestActivityState kind={activityLoading ? 'loading' : 'conversation'} />
                  )}
                </div>
              ) : pullRequestDetailTab === 'commits' ? (
                <div className={styles.pullRequestCommits}>
                  {commitsNewestFirst.map((commitEntry) => (
                    <button
                      type="button"
                      className={styles.pullRequestCommit}
                      key={commitEntry.oid}
                      aria-pressed={selectedPullRequestCommit?.oid === commitEntry.oid}
                      onClick={() => selectPullRequestCommit(commitEntry)}
                    >
                      <span className={styles.pullRequestCommitIcon} aria-hidden="true">
                        <GitCommitHorizontal />
                      </span>
                      <span className={styles.pullRequestCommitCopy}>
                        <strong>{commitEntry.headline}</strong>
                        <small>
                          {commitEntry.authors.join(', ') || 'Unknown author'} · {formatGitDate(commitEntry.authoredAt)}
                        </small>
                      </span>
                      <code>{commitEntry.oid.slice(0, 7)}</code>
                    </button>
                  ))}
                  {(pullRequestDetails?.commits.length ?? 0) === 0 && (
                    <PullRequestActivityState kind={activityLoading ? 'loading' : 'commits'} />
                  )}
                </div>
              ) : !selectedPullRequestCommit ? null : pullRequestDiffError && !pullRequestDiffLoading ? (
                <div
                  className={styles.pullRequestActivityState}
                  role="alert"
                >
                  <EmptyState
                    className={styles.pullRequestEmptyState}
                    title="Could not load changes"
                    description={pullRequestDiffError}
                  />
                </div>
              ) : (
                <GitDiffViewer
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                  embedded
                  key={selectedPullRequestCommit.oid}
                  diff={pullRequestDiff}
                  emptyMessage="No file changes were returned for this commit."
                  files={pullRequestDiffFiles}
                  filesLabel={`Files changed in commit ${selectedPullRequestCommit.oid.slice(0, 7)}`}
                  loading={pullRequestDiffLoading}
                  review={pullRequestDetails && pullRequestDiff ? {
                    details: pullRequestDetails,
                    commitOid: selectedPullRequestCommit.oid,
                    submitting: pullRequestReviewSubmitting,
                    onAddComment: addPullRequestReviewComment,
                    onSubmit: submitPullRequestReview,
                  } : undefined}
                  selectedPath={selectedPullRequestDiffPath}
                  onSelectPath={setSelectedPullRequestDiffPath}
                />
              )}
            </section>
          </section>
          <footer className={styles.pullRequestActions}>
            <div className={styles.pullRequestActionGroup}>
              {selectedPullRequestNeedsPush && (
                <NeumorphicButton
                  variant="standard"
                  aria-busy={pullRequestOperation === 'push'}
                  disabled={busy}
                  onClick={() => void pushCurrentBranch()}
                >
                  {pullRequestOperation === 'push' ? (
                    <LoaderCircle className={styles.spinner} aria-hidden="true" />
                  ) : (
                    <Upload aria-hidden="true" />
                  )}
                  {pullRequestOperation === 'push'
                    ? 'Pushing…'
                    : `Push ${selectedPullRequest.headRefName}`}
                </NeumorphicButton>
              )}
              <NeumorphicButton
                variant="standard"
                disabled={busy || selectedPullRequest.draft || selectedPullRequestNeedsPush}
                title={selectedPullRequest.draft
                  ? 'Draft pull requests cannot be merged.'
                  : selectedPullRequestNeedsPush
                    ? `Push ${selectedPullRequest.headRefName} before merging.`
                    : undefined}
                onClick={() => beginMerge(selectedPullRequest)}
              >
                <GitMerge aria-hidden="true" />
                Merge pull request
              </NeumorphicButton>
            </div>
            <div className={styles.pullRequestActionGroup}>
              <NeumorphicButton
                variant="ghost"
                disabled={busy}
                onClick={() => checkoutPullRequest(selectedPullRequest.number)}
              >
                Checkout
              </NeumorphicButton>
              <NeumorphicButton
                variant="ghost"
                disabled={busy}
                onClick={() => openPullRequest(selectedPullRequest.url)}
              >
                Open GitHub <ExternalLink aria-hidden="true" />
              </NeumorphicButton>
            </div>
          </footer>
        </>
      ) : mergedPullRequest ? (
        <MergedPullRequestDetail
          busy={busy}
          checkingCleanup={pullRequestCleanupChecking}
          cleaningBranch={pullRequestOperation === 'cleanup-branch'}
          deletingBranch={pullRequestOperation === 'delete-branch'}
          pushingBranch={pullRequestOperation === 'push'}
          hasLocalChanges={(controller.snapshot.changes?.length ?? 0) > 0}
          mergedPullRequest={mergedPullRequest}
          onCleanupBranch={() => void cleanupMergedPullRequestBranch()}
          onDeleteBranch={() => void deleteMergedPullRequestBranch()}
          onPushBranch={() => void pushMergedPullRequestBranch()}
        />
      ) : (
        <>
          <header className={`${styles.panelHeader} ${styles.pullRequestDetailHeader}`}>
            <SidebarPanelTitle icon={<GitPullRequest aria-hidden="true" />} title="PULL REQUEST DETAIL" />
          </header>
          <EmptyState
            className={styles.pullRequestEmptyState}
            title="Select a pull request"
            description="Choose an open pull request from the list to inspect its activity."
          />
        </>
      )}
    </LiquidGlassPanel>
  );
}
