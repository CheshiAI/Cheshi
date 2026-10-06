import { useEffect, useState } from 'react';
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
  active?: boolean;
  sidebarTarget?: HTMLElement | null;
  onOpenChanges?: () => void;
  onOpenWorkspaceFile: (path: string) => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function GitWorkspace({ active = true, sidebarTarget, onOpenChanges,
  rightSidebarOpen, onToggleRightSidebar, onOpenWorkspaceFile }: GitWorkspaceProps) {
  const [issueRevision, setIssueRevision] = useState(0);
  const [issuesVisited, setIssuesVisited] = useState(false);
  const controller = useGitWorkspaceController();
  const { loading, snapshot, tab } = controller;
  const issuesActive = snapshot.available && tab === 'issues';
  useEffect(() => {
    if (issuesActive) setIssuesVisited(true);
  }, [issuesActive]);
  const unavailable = loading ? <LoadingState className={styles.loadingState} /> : (
    <div className={styles.unavailable}>
      <AlertTriangle aria-hidden="true" />
      <strong>Git repository unavailable</strong>
      <span>{snapshot.message}</span>
    </div>
  );

  return (
    <main className={styles.workspace} aria-label="Git workspace" hidden={!active}>
      <GitWorkspaceHeader
        controller={controller}
        onRefreshIssues={tab === 'issues' ? () => setIssueRevision(value => value + 1) : undefined}
        rightSidebarOpen={rightSidebarOpen}
        onToggleRightSidebar={onToggleRightSidebar}
      />

      {!snapshot.available && unavailable}
      <GitChangesWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile}
        sidebarTarget={sidebarTarget} active={snapshot.available && tab === 'changes'} onOpenChanges={() => {
          if (tab !== 'changes') controller.selectTab('changes');
          onOpenChanges?.();
        }} />
      {/* Keep the existing issue caches and view state alive after the first visit. */}
      {(issuesVisited || issuesActive) && <GitIssuesWorkspace revision={issueRevision} active={issuesActive} />}
      {snapshot.available && (tab === 'log' ? (
        <GitHistoryWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      ) : tab === 'pull-requests' ? (
        <GitPullRequestsWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      ) : null)}
    </main>
  );
}
