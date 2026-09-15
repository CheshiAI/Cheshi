import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { observeWorkspaceGitStatus, workspaceGitChangedPaths } from '../../shared/workspaceGitStatus';

export function useWorkspaceGitChangedPaths() {
  const [paths, setPaths] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!cheshiDesktop?.getGitSnapshot || !cheshiDesktop.onGitRepositoryChanged) return;
    return observeWorkspaceGitStatus(cheshiDesktop, snapshot => {
      setPaths(workspaceGitChangedPaths(snapshot));
    });
  }, []);
  return paths;
}
