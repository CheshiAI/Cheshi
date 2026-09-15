import { useState } from 'react';
import { GitIssuesWorkspace } from './GitIssuesWorkspace';
import { AlertTriangle } from 'lucide-react';

import { LoadingState } from '../../shared/ui';
import { GitChangesWorkspace } from './GitChangesWorkspace';
import { GitHistoryWorkspace } from './GitHistoryWorkspace';
import { GitPullRequestsWorkspace } from './GitPullRequestsWorkspace';
import { GitWorkspaceHeader } from './GitWorkspaceHeader';
import styles from './GitWorkspace.module.css';
import { useGitWorkspaceController } from './useGitWorkspaceController';

interface GitWorkspaceProps {
  onOpenWorkspaceFile: (path: string) => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function GitWorkspace({ rightSidebarOpen, onToggleRightSidebar, onOpenWorkspaceFile }: GitWorkspaceProps) {
  const [issueRevision, setIssueRevision] = useState(0);
  const controller = useGitWorkspaceController();
  const { loading, snapshot, tab } = controller;

  return (
    <main className={styles.workspace} aria-label="Git workspace">
      <GitWorkspaceHeader
        controller={controller}
        onRefreshIssues={tab === 'issues' ? () => setIssueRevision(value => value + 1) : undefined}
        rightSidebarOpen={rightSidebarOpen}
        onToggleRightSidebar={onToggleRightSidebar}
      />

      {!snapshot.available ? (
        loading ? (
          <LoadingState className={styles.loadingState} />
        ) : (
          <div className={styles.unavailable}>
            <AlertTriangle aria-hidden="true" />
            <strong>Git repository unavailable</strong>
            <span>{snapshot.message}</span>
          </div>
        )
      ) : tab === 'changes' ? (
        <GitChangesWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      ) : tab === 'issues' ? (
        <GitIssuesWorkspace revision={issueRevision} />
      ) : tab === 'log' ? (
        <GitHistoryWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      ) : (
        <GitPullRequestsWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      )}
    </main>
  );
}
