import { GitPullRequestDetailPanel } from './GitPullRequestDetailPanel';
import { GitPullRequestListPanel } from './GitPullRequestListPanel';
import styles from './GitWorkspace.module.css';
import type { GitWorkspaceController } from './useGitWorkspaceController';

export function GitPullRequestsWorkspace({ controller, onOpenWorkspaceFile }: {
  controller: GitWorkspaceController;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  return (
    <div className={styles.splitLayout}>
      <GitPullRequestListPanel controller={controller} />
      <GitPullRequestDetailPanel controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile} />
    </div>
  );
}
