import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceProject } from '../../../../shared/workspace-projects';
import { projectFilePath } from '../../../../shared/workspace-projects';
import { cheshiDesktop, type GitRepositorySnapshot } from '../../cheshiDesktop';
import { projectGitApi } from '../../shared/workspaceProjects';
import { observeWorkspaceGitStatus, workspaceGitChangedPaths } from '../../shared/workspaceGitStatus';

/** One project snapshot drives both the root summary and changed file names. */
export function useWorkspaceProjectGitStatus(project?: WorkspaceProject, desktop = cheshiDesktop) {
  const api = useMemo(() => project ? projectGitApi(desktop, project) : desktop,
    [desktop, project?.id, project?.rootPath, project?.primary]);
  const [current, setCurrent] = useState<{ api: typeof api; snapshot: GitRepositorySnapshot | null } | null>(null);
  useEffect(() => {
    if (!api?.getGitSnapshot || !api.onGitRepositoryChanged || project?.available === false) return;
    return observeWorkspaceGitStatus(api, snapshot => setCurrent({ api, snapshot }));
  }, [api, project?.available]);
  const snapshot = project?.available !== false && current?.api === api ? current?.snapshot ?? null : null;
  const changedPaths = useMemo(() => {
    const paths = workspaceGitChangedPaths(snapshot);
    return project ? new Set([...paths].map(file => projectFilePath(project, file))) : paths;
  }, [snapshot, project?.rootPath, project?.primary]);
  return { snapshot, changedPaths };
}
