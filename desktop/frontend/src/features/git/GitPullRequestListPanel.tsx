import {
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Upload,
} from 'lucide-react';

import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import { MarkedPanelTitle } from './GitPullRequestPanels';
import styles from './GitWorkspace.module.css';
import type { GitWorkspaceController } from './useGitWorkspaceController';

export function GitPullRequestListPanel({ controller }: { controller: GitWorkspaceController }) {
  const {
    busy,
    createPullRequest,
    mergedPullRequest,
    pullRequestEmptyMessage,
    pullRequestHasNoCommits,
    pullRequestNeedsPush,
    pullRequestOperation,
    pullRequests,
    pullRequestsLoading,
    pushCurrentBranch,
    refreshPullRequests,
    selectedPullRequest,
    selectPullRequest,
    snapshot,
  } = controller;

  return (
    <LiquidGlassPanel as="section" className={styles.listPanel} data-liquid-glass-surface="side-panel">
      <header className={styles.panelHeader}>
        <MarkedPanelTitle icon={GitPullRequest} title="Open pull requests" />
        <NeumorphicButton
          raised
          aria-busy={pullRequestsLoading}
          aria-label={pullRequestsLoading ? 'Refreshing pull requests' : 'Refresh pull requests'}
          className={`theme-toggle ${styles.smallAction}`}
          disabled={busy || pullRequestsLoading}
          title={pullRequestsLoading ? 'Refreshing pull requests…' : 'Refresh pull requests'}
          onClick={() => void refreshPullRequests()}
        >
          <RefreshCw className={pullRequestsLoading ? styles.spinner : undefined} aria-hidden="true" />
        </NeumorphicButton>
      </header>
      {!pullRequests.available ? (
        <div className={`${styles.pullRequestList} ${styles.emptyState}`}>
          {pullRequests.message || 'Loading pull requests…'}
        </div>
      ) : (
        <div
          className={`${styles.pullRequestList} ${
            pullRequests.pullRequests.length === 0 ? styles.pullRequestListEmpty : ''
          }`}
        >
          {pullRequests.pullRequests.map((pullRequest) => (
            <button
              aria-current={selectedPullRequest?.number === pullRequest.number ? 'true' : undefined}
              className={styles.pullRequestRow}
              key={pullRequest.number}
              type="button"
              onClick={() => selectPullRequest(pullRequest)}
            >
              <GitPullRequest aria-hidden="true" />
              <span>
                <strong>{pullRequest.title}</strong>
                <small>#{pullRequest.number} · {pullRequest.author ?? 'unknown'}</small>
              </span>
              {pullRequest.draft && <em className={styles.pullRequestDraftBadge}>Draft</em>}
            </button>
          ))}
          {pullRequests.pullRequests.length === 0 && (
            <div className={`${styles.emptyState} ${styles.pullRequestEmptyState}`}>
              <span>{pullRequestEmptyMessage}</span>
              {!mergedPullRequest
                && snapshot.detached !== true
                && snapshot.head
                && !pullRequestHasNoCommits
                && (
                  <NeumorphicButton
                    size="standard"
                    raised
                    aria-busy={pullRequestOperation !== null}
                    className={`neumorphic-surface ${styles.pullRequestEmptyAction}`}
                    disabled={busy}
                    onClick={() => void (pullRequestNeedsPush ? pushCurrentBranch() : createPullRequest())}
                  >
                    {pullRequestOperation !== null ? (
                      <LoaderCircle className={styles.spinner} aria-hidden="true" />
                    ) : pullRequestNeedsPush ? (
                      <Upload aria-hidden="true" />
                    ) : (
                      <GitPullRequest aria-hidden="true" />
                    )}
                    <span>
                      {pullRequestOperation === 'push'
                        ? 'Pushing…'
                        : pullRequestOperation === 'create'
                          ? 'Creating…'
                          : pullRequestNeedsPush
                            ? `Push ${snapshot.head}`
                            : 'Create pull request'}
                    </span>
                  </NeumorphicButton>
                )}
            </div>
          )}
        </div>
      )}
    </LiquidGlassPanel>
  );
}
