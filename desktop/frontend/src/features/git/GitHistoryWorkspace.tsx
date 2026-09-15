import { GitBranch, History } from 'lucide-react';
import { useMemo } from 'react';

import { LiquidGlassPanel } from '../../shared/ui';
import { GitBranchTree } from './GitBranchTree';
import { GitCommitGraph } from './GitCommitGraph';
import { buildCommitGraph } from './gitCommitGraphLayout';
import { GitDiffViewer } from './GitDiffViewer';
import { formatGitDate } from './gitWorkspaceModel';
import { MarkedPanelTitle } from './GitPullRequestPanels';
import styles from './GitWorkspace.module.css';
import type { GitWorkspaceController } from './useGitWorkspaceController';

export function GitHistoryWorkspace({ controller, onOpenWorkspaceFile }: {
  controller: GitWorkspaceController;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  const {
    branchHistory,
    busy,
    checkoutBranch,
    createBranch,
    snapshot,
    updateBranch,
  } = controller;
  const graph = useMemo(() => buildCommitGraph(branchHistory.commits), [branchHistory.commits]);

  return (
    <div className={styles.splitLayout}>
      <LiquidGlassPanel as="section" className={styles.listPanel} data-liquid-glass-surface="side-panel">
        <header className={styles.panelHeader}>
          <MarkedPanelTitle icon={GitBranch} title="HEAD" />
          <span>{snapshot.head ?? 'unborn'}{snapshot.detached === true ? ' · detached' : ''}</span>
        </header>
        <GitBranchTree
          branches={snapshot.branches ?? []}
          disabled={busy}
          selectedReference={branchHistory.selectedReference}
          onSelect={branchHistory.selectBranch}
          onCheckout={(branch) => checkoutBranch(branch.name)}
          onCreate={(branch, branchName) => createBranch(branchName, branch.fullName, branch.name)}
          onUpdate={(branch) => updateBranch(branch.fullName, branch.name)}
        />
        <header className={styles.panelHeader}>
          <MarkedPanelTitle icon={History} title="Commit log" />
          <span className={styles.historyBranchName} title={branchHistory.branchName}>{branchHistory.branchName}</span>
          <small className={styles.changeCountBadge}>{branchHistory.commits.length}</small>
        </header>
        <div
          aria-label={`Commits for ${branchHistory.branchName}`}
          aria-busy={branchHistory.commitsLoading}
          className={styles.commitList}
        >
          {branchHistory.error && <p className={styles.historyStatus} role="alert">{branchHistory.error}</p>}
          {branchHistory.commitsLoading && <p className={styles.historyStatus} role="status">Loading commits…</p>}
          {!branchHistory.commitsLoading && !branchHistory.error && branchHistory.commits.length === 0 && (
            <p className={styles.historyStatus} role="status">No commits.</p>
          )}
          {branchHistory.commits.map((entry, index) => (
            <button
              aria-current={branchHistory.selectedCommit?.hash === entry.hash ? 'true' : undefined}
              className={styles.commitRow}
              key={entry.hash}
              type="button"
              onClick={() => branchHistory.selectCommit(entry.hash)}
              style={{ minWidth: graph.laneCount * 16 + 180 }}
              aria-label={`${entry.subject}${entry.parents?.length > 1 ? ', merge commit' : ''}`}
            >
              <GitCommitGraph row={graph.rows[index]!} laneCount={graph.laneCount} />
              <span className={styles.commitText}>
                <strong>{entry.subject}</strong>
                <span>{entry.authorName} · {formatGitDate(entry.authoredAt)}</span>
              </span>
              <code>{entry.shortHash}</code>
            </button>
          ))}
        </div>
      </LiquidGlassPanel>
      <GitDiffViewer
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        diff={branchHistory.diff}
        files={branchHistory.diffFiles}
        loading={branchHistory.diffLoading}
        selectedPath={branchHistory.selectedDiffPath}
        onSelectPath={branchHistory.selectDiffPath}
        emptyMessage={branchHistory.error ?? 'Select a commit to inspect its changes.'}
      />
    </div>
  );
}
