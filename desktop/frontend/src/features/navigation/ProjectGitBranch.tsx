import { GitBranch } from 'lucide-react';
import type { GitRepositorySnapshot } from '../../cheshiDesktop';
import { Tooltip } from '../../shared/ui';
import { workspaceGitBranchLabels, workspaceGitFileCounts } from '../../shared/workspaceGitBranchModel';
import styles from './WorkspaceProjects.module.css';

export function ProjectGitBranch({ snapshot }: { snapshot: GitRepositorySnapshot | null }) {
  if (snapshot?.available !== true) return null;
  const { label, title } = workspaceGitBranchLabels(snapshot);
  return <Tooltip content={title}>{tooltip => <span {...tooltip} className={styles.branch} aria-label={title}>
    <GitBranch aria-hidden="true" />
    <span className={styles.branchName}>{label}</span>
  </span>}</Tooltip>;
}

export function ProjectGitFileCounts({ snapshot }: { snapshot: GitRepositorySnapshot | null }) {
  const { changed, deleted } = workspaceGitFileCounts(snapshot);
  if (changed + deleted === 0) return null;
  const title = `${changed} added or modified files, ${deleted} deleted files`;
  return <Tooltip content={title}>{tooltip => <span {...tooltip} className={styles.counts} aria-label={title}>
    {changed > 0 && <span className={styles.changed}>+{changed}</span>}
    {deleted > 0 && <span className={styles.deleted}>−{deleted}</span>}
  </span>}</Tooltip>;
}
