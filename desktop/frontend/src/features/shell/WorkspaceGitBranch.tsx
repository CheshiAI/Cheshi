import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cheshiDesktop, type GitRepositorySnapshot } from '../../cheshiDesktop';
import { observeWorkspaceGitBranch, workspaceGitBranchLabels, workspaceGitFileCounts } from './workspaceGitBranchModel';
import styles from './WorkspaceGitBranch.module.css';

export function WorkspaceGitBranch() {
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(cheshiDesktop?.getGitSnapshot));
  useEffect(() => {
    if (!cheshiDesktop?.getGitSnapshot || !cheshiDesktop.onGitRepositoryChanged) {
      setLoading(false);
      return;
    }
    return observeWorkspaceGitBranch(cheshiDesktop, value => {
      setSnapshot(value);
      setLoading(false);
    });
  }, []);
  const labels = loading
    ? { label: 'Checking branch…', title: 'Checking the current Git branch…' }
    : workspaceGitBranchLabels(snapshot);
  const counts = workspaceGitFileCounts(snapshot);
  const hasChanges = !loading && counts.changed + counts.deleted > 0;
  const changesTitle = `${counts.changed} added or modified files, ${counts.deleted} deleted files`;

  return <div className={styles.branch} aria-label="Current Git branch" aria-busy={loading}
    title={hasChanges ? `${labels.title} · ${changesTitle}` : labels.title}>
    <GitBranch aria-hidden="true" />
    <span className={styles.name} aria-live="polite">{labels.label}</span>
    {hasChanges && <span className={styles.counts} role="status" aria-label={changesTitle}>
      <span className={styles.changed} aria-hidden="true">+{counts.changed}</span>
      <span className={styles.deleted} aria-hidden="true">−{counts.deleted}</span>
    </span>}
  </div>;
}
