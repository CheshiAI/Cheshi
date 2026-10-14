import { GitProjectContext } from './GitProjectContext';
import { cheshiDesktop } from '../../cheshiDesktop';
import { useWorkspaceProjects, projectGitApi, primaryProject } from '../../shared/workspaceProjects';
import { projectFilePath, type WorkspaceProject } from '../../../../shared/workspace-projects';
import { EmptyState, LiquidGlassSelect, LoadingState } from '../../shared/ui';
import { memo, useEffect, useState, useMemo, useRef } from 'react';
import { GitIssuesWorkspace } from './GitIssuesWorkspace';
import { GitChangesWorkspace } from './GitChangesWorkspace';
import { GitHistoryWorkspace } from './GitHistoryWorkspace';
import { GitPullRequestsWorkspace } from './GitPullRequestsWorkspace';
import { GitWorkspaceHeader } from './GitWorkspaceHeader';
import styles from './GitWorkspace.module.css';
import sidebarStyles from './GitChangesSidebar.module.css';
import { useGitWorkspaceController } from './useGitWorkspaceController';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';

interface GitWorkspaceProps {
  active?: boolean;
  sidebarTarget?: HTMLElement | null;
  onOpenChanges?: () => void;
  onOpenWorkspaceFile: (path: string) => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

function ProjectGitWorkspace({ active = true, sidebarTarget, onOpenChanges,
  rightSidebarOpen, onToggleRightSidebar, onOpenWorkspaceFile, project, projects, selectProject }: GitWorkspaceProps & { project: WorkspaceProject; projects: WorkspaceProject[]; selectProject(id: string): void }) {
  const [issueRevision, setIssueRevision] = useState(0);
  const [issuesVisited, setIssuesVisited] = useState(false);
  const menuBlurSourceRef = useRef(document.getElementById('app'));
  const scrollbarsRef = useAutoHideScrollbars<HTMLElement>();
  const controller = useGitWorkspaceController();
  const { loading, snapshot, tab } = controller;
  const issuesActive = snapshot.available && tab === 'issues';
  useEffect(() => {
    if (issuesActive) setIssuesVisited(true);
  }, [issuesActive]);
  const unavailable = loading ? <LoadingState className={styles.loadingState} /> : (
    <EmptyState
      className={styles.unavailable}
      title="Git repository unavailable"
      description={snapshot.message}
    />
  );

  return (
    <main ref={scrollbarsRef} className={styles.workspace} aria-label="Git workspace" hidden={!active}>
      <GitWorkspaceHeader
        controller={controller}
        onRefreshIssues={tab === 'issues' ? () => setIssueRevision(value => value + 1) : undefined}
        rightSidebarOpen={rightSidebarOpen}
        onToggleRightSidebar={onToggleRightSidebar}
      />

      {!snapshot.available && unavailable}
      <GitChangesWorkspace controller={controller} onOpenWorkspaceFile={onOpenWorkspaceFile}
        projectSelector={projects.length > 1 ? (
          <LiquidGlassSelect ariaLabel="Git project" value={project.id} disabled={controller.busy}
            triggerAppearance="standard" menuAppearance="toolbar"
            menuClassName={sidebarStyles.projectMenu} menuBlurSourceRef={menuBlurSourceRef} menuBlurSourceMode="replace"
            options={projects.map(entry => ({ value: entry.id, label: entry.name, description: entry.rootPath, disabled: !entry.available }))}
            onChange={selectProject} />
        ) : undefined}
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

export const GitWorkspace = memo(function GitWorkspace(props: GitWorkspaceProps) {
  const { projects } = useWorkspaceProjects();
  const [selected, setSelected] = useState('primary');
  const project = projects.find(entry => entry.id === selected) ?? projects[0] ?? primaryProject;
  const api = useMemo(() => projectGitApi(cheshiDesktop, project), [project.id, project.rootPath]);
  return <GitProjectContext.Provider value={api}>
    <ProjectGitWorkspace key={project.id} {...props} project={project} projects={projects} selectProject={setSelected}
      onOpenWorkspaceFile={file => props.onOpenWorkspaceFile(projectFilePath(project, file))} />
  </GitProjectContext.Provider>;
});
