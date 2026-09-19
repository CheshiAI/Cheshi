import { FileText, LoaderCircle, MessageSquareText, Plus } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import {
  EmptyState,
  LiquidGlassPanel,
  LiquidGlassSelect,
  LoadingState,
  NeumorphicButton,
  NeumorphicTextarea,
} from '../../shared/ui';
import type {
  GitHubPullRequestDetails,
  GitHubPullRequestReviewCommentMode,
  GitHubPullRequestReviewEvent,
  GitHubPullRequestReviewThread,
} from '../../cheshiDesktop';
import {
  GITHUB_COMMENT_BODY_LIMIT,
  pullRequestReviewEvents,
  pullRequestReviewLocation,
  pullRequestReviewLocationKey,
  type PullRequestReviewLocation,
} from './gitWorkspaceModel';
import { MarkedPanelTitle, PullRequestReviewThread } from './GitPullRequestPanels';
import styles from './GitWorkspace.module.css';
import type { UnifiedDiffFile } from './unifiedDiff';
import { GitDiffFileRow } from './GitDiffFileRow';

interface DiffViewerResult {
  path: string | null;
  truncated: boolean;
  binary: boolean;
}

interface DiffViewerProps {
  diff: DiffViewerResult | null;
  files: UnifiedDiffFile[];
  loading: boolean;
  selectedPath: string | null;
  onSelectPath?: (path: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  targetLine?: { path: string; line: number };
  embedded?: boolean;
  emptyMessage?: string;
  filesLabel?: string;
  review?: {
    details: GitHubPullRequestDetails;
    commitOid?: string;
    submitting: boolean;
    onAddComment: (
      location: PullRequestReviewLocation,
      body: string,
      mode: GitHubPullRequestReviewCommentMode,
    ) => Promise<boolean>;
    onSubmit: (event: GitHubPullRequestReviewEvent) => Promise<boolean>;
  };
}

function reviewThreadMatchesDiff(thread: GitHubPullRequestReviewThread, review: DiffViewerProps['review']): boolean {
  // PR thread positions refer to its base/head diff, not an older commit's parent diff.
  return !review?.commitOid
    || (review.commitOid === review.details.headRefOid && thread.side === 'RIGHT');
}

export const GitDiffViewer = memo(function GitDiffViewer({
  diff,
  files,
  loading,
  selectedPath,
  onSelectPath,
  onOpenWorkspaceFile,
  targetLine,
  embedded = false,
  emptyMessage = 'Select a changed file or commit to inspect its diff.',
  filesLabel = 'Files in diff',
  review,
}: DiffViewerProps) {
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.querySelector<HTMLElement>('[data-line-target="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [selectedFile, targetLine?.path, targetLine?.line]);
  const [editorLocation, setEditorLocation] = useState<PullRequestReviewLocation | null>(null);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewEvent, setReviewEvent] = useState<GitHubPullRequestReviewEvent>('COMMENT');
  const reviewThreadsByLocation = useMemo(() => {
    const threads = new Map<string, GitHubPullRequestReviewThread[]>();
    for (const thread of review?.details.reviewThreads ?? []) {
      if (thread.line === null || thread.outdated || thread.subjectType !== 'LINE'
        || !reviewThreadMatchesDiff(thread, review)) continue;
      const key = pullRequestReviewLocationKey({
        path: thread.path,
        line: thread.line,
        side: thread.side,
      });
      const matchingThreads = threads.get(key) ?? [];
      matchingThreads.push(thread);
      threads.set(key, matchingThreads);
    }
    return threads;
  }, [review?.commitOid, review?.details.headRefOid, review?.details.reviewThreads]);
  const unmatchedReviewThreads = useMemo(() => (
    (review?.details.reviewThreads ?? []).filter((thread) => (
      thread.path === selectedFile?.path
      && (
        thread.line === null
        || thread.outdated
        || thread.subjectType !== 'LINE'
        || !reviewThreadMatchesDiff(thread, review)
      )
    ))
  ), [review?.commitOid, review?.details.headRefOid, review?.details.reviewThreads, selectedFile?.path]);

  useEffect(() => {
    setEditorLocation(null);
    setReviewBody('');
  }, [selectedPath]);

  const closeReviewEditor = (): void => {
    setEditorLocation(null);
    setReviewBody('');
  };

  const addReviewComment = async (mode: GitHubPullRequestReviewCommentMode): Promise<void> => {
    const body = reviewBody.trim();
    if (!review || !editorLocation || !body) return;
    const added = await review.onAddComment(editorLocation, body, mode);
    if (added) closeReviewEditor();
  };

  const content = loading && !selectedFile ? (
    <LoadingState className={styles.loadingState} />
  ) : (
    <>
      <header className={styles.panelHeader}>
        <MarkedPanelTitle icon={FileText} title={selectedFile?.path ?? diff?.path ?? 'Diff'} />
        {(loading || selectedFile) && (
          <div className={styles.diffHeaderMeta}>
            {loading && (
              <span
                aria-label="Loading diff"
                className={styles.diffLoadingIndicator}
                role="status"
              >
                <LoaderCircle className={styles.spinner} aria-hidden="true" />
              </span>
            )}
            {selectedFile && (
              <span className={styles.diffSummary}>
                <span data-kind="addition">+{selectedFile.additions}</span>
                <span data-kind="deletion">−{selectedFile.deletions}</span>
              </span>
            )}
          </div>
        )}
      </header>
      {review?.details.pendingReview && (
        <aside className={styles.pendingReviewBar} aria-label="Pending pull request review">
          <span>
            <MessageSquareText aria-hidden="true" />
            <span>
              <strong>Review in progress</strong>
              <small>
                {review.details.pendingReview.commentCount.toLocaleString()} pending
                {' '}{review.details.pendingReview.commentCount === 1 ? 'comment' : 'comments'}
              </small>
            </span>
          </span>
          <div>
            <LiquidGlassSelect
              ariaLabel="Review decision"
              className={styles.pendingReviewSelect}
              disabled={review.submitting}
              menuLabel="Pull request review decision"
              onChange={setReviewEvent}
              options={pullRequestReviewEvents}
              value={reviewEvent}
            />
            <NeumorphicButton
              size="standard"
              raised
              aria-busy={review.submitting}
              className="neumorphic-surface"
              disabled={review.submitting}
              onClick={() => void review.onSubmit(reviewEvent)}
            >
              {review.submitting && <LoaderCircle className={styles.spinner} aria-hidden="true" />}
              Submit review
            </NeumorphicButton>
          </div>
        </aside>
      )}
      {files.length > 1 && onSelectPath && (
        <nav className={styles.diffFiles} aria-label={filesLabel}>
          {files.map((file) => (
            <GitDiffFileRow
              key={file.path}
              path={file.path}
              selected={file.path === selectedFile?.path}
              onSelectPath={onSelectPath}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ))}
        </nav>
      )}
      <div ref={contentRef} aria-busy={loading} className={styles.diffContent}>
        {diff?.binary && !selectedFile ? (
          <div className={styles.emptyState}>Binary file changes cannot be rendered as text.</div>
        ) : !selectedFile ? (
          <EmptyState
            className={styles.diffEmptyState}
            title={diff ? 'No changes to display' : 'Open a diff'}
            description={emptyMessage}
          />
        ) : (
          <div className={styles.diffLines} role="table" aria-label={`Diff for ${selectedFile.path}`}>
            {selectedFile.lines.map((line, index) => {
              const location = pullRequestReviewLocation(selectedFile, line);
              const locationKey = location ? pullRequestReviewLocationKey(location) : null;
              const lineThreads = locationKey ? reviewThreadsByLocation.get(locationKey) ?? [] : [];
              const editing = locationKey !== null
                && editorLocation !== null
                && pullRequestReviewLocationKey(editorLocation) === locationKey;
              return (
                <div className={styles.diffLineGroup} key={`${index}:${line.content}`} role="rowgroup">
                  <div
                    className={styles.diffLine}
                    data-commentable={review && location ? 'true' : undefined}
                    data-kind={line.kind}
                    data-line-target={selectedFile.path === targetLine?.path && line.newLine === targetLine?.line ? 'true' : undefined}
                    data-reviewable={review ? 'true' : undefined}
                    role="row"
                  >
                    {review && (
                      <span className={styles.diffCommentCell} role="cell">
                        {location && (
                          <NeumorphicButton
                            raised
                            aria-label={`Comment on ${location.path} line ${location.line}`}
                            className={`neumorphic-surface ${styles.diffCommentTrigger}`}
                            onClick={() => {
                              setEditorLocation(location);
                              setReviewBody('');
                            }}
                          >
                            <Plus aria-hidden="true" />
                          </NeumorphicButton>
                        )}
                      </span>
                    )}
                    <span className={styles.lineNumber} role="cell">{line.oldLine ?? ''}</span>
                    <span className={styles.lineNumber} role="cell">{line.newLine ?? ''}</span>
                    <span className={styles.lineMarker} role="cell">
                      {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}
                    </span>
                    <code role="cell">{line.content || ' '}</code>
                  </div>
                  {lineThreads.map((thread) => (
                    <div className={styles.inlineReviewRow} key={thread.id} role="row">
                      <div role="cell">
                        <PullRequestReviewThread thread={thread} />
                      </div>
                    </div>
                  ))}
                  {editing && location && review && (
                    <div
                      className={`${styles.inlineReviewRow} ${styles.inlineReviewEditorRow}`}
                      role="row"
                    >
                      <div role="cell">
                        <section
                          aria-label={`Comment on ${location.path} line ${location.line}`}
                          className={styles.inlineReviewEditor}
                        >
                          <header>
                            <MessageSquareText aria-hidden="true" />
                            <strong>Comment on line {location.line}</strong>
                          </header>
                          <NeumorphicTextarea
                            autoFocus
                            aria-label={`Review comment on ${location.path} line ${location.line}`}
                            disabled={review.submitting}
                            maxLength={GITHUB_COMMENT_BODY_LIMIT}
                            placeholder="Leave a comment"
                            rows={5}
                            value={reviewBody}
                            onChange={(event) => setReviewBody(event.target.value)}
                          />
                          <footer>
                            <span>Markdown is supported by GitHub.</span>
                            <div>
                              <NeumorphicButton
                                size="standard"
                                raised
                                className="neumorphic-surface"
                                disabled={review.submitting}
                                onClick={closeReviewEditor}
                              >
                                Cancel
                              </NeumorphicButton>
                              <NeumorphicButton
                                size="standard"
                                raised
                                className="neumorphic-surface"
                                disabled={review.submitting || !reviewBody.trim()}
                                onClick={() => void addReviewComment('comment')}
                              >
                                Comment
                              </NeumorphicButton>
                              <NeumorphicButton
                                size="standard"
                                raised
                                className="neumorphic-surface"
                                disabled={review.submitting || !reviewBody.trim()}
                                onClick={() => void addReviewComment('review')}
                              >
                                {review.submitting && (
                                  <LoaderCircle className={styles.spinner} aria-hidden="true" />
                                )}
                                {review.details.pendingReview ? 'Add to review' : 'Start a review'}
                              </NeumorphicButton>
                            </div>
                          </footer>
                        </section>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {unmatchedReviewThreads.length > 0 && (
              <div className={styles.outdatedReviewThreads} role="rowgroup">
                <div role="row">
                  <strong role="cell">{review?.commitOid ? 'Pull request review comments' : 'Outdated review comments'}</strong>
                </div>
                {unmatchedReviewThreads.map((thread) => (
                  <div className={styles.inlineReviewRow} key={thread.id} role="row">
                    <div role="cell">
                      <PullRequestReviewThread thread={thread} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {diff?.truncated && <footer className={styles.diffWarning}>Diff output was truncated.</footer>}
    </>
  );

  if (embedded) {
    return (
      <section aria-busy={loading} className={`${styles.diffPanel} ${styles.pullRequestChangesViewer}`}>
        {content}
      </section>
    );
  }

  return (
    <LiquidGlassPanel
      as="section"
      aria-busy={loading}
      className={styles.diffPanel}
      data-liquid-glass-surface="side-panel"
    >
      {content}
    </LiquidGlassPanel>
  );
});
