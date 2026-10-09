import type { WorkspaceProject } from '../../../../shared/workspace-projects';
import { projectFilePath } from '../../../../shared/workspace-projects';
import { projectGitApi } from '../../shared/workspaceProjects';
import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { observeWorkspaceGitStatus, workspaceGitChangedPaths } from '../../shared/workspaceGitStatus';

export function useWorkspaceGitChangedPaths(project?: WorkspaceProject, desktop = cheshiDesktop) {
  const [paths, setPaths] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!desktop?.getGitSnapshot || !desktop.onGitRepositoryChanged) return;
    const api = project ? projectGitApi(desktop, project)! : desktop;
    return observeWorkspaceGitStatus(api, snapshot => {
      const changed = workspaceGitChangedPaths(snapshot);
      setPaths(project ? new Set([...changed].map(file => projectFilePath(project, file))) : changed);
    });
  }, [project?.id, desktop]);
  return paths;
}
