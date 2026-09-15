import type { GitRepositorySnapshot } from '../../cheshiDesktop';
export { observeWorkspaceGitStatus as observeWorkspaceGitBranch } from '../../shared/workspaceGitStatus';

export function workspaceGitBranchLabels(snapshot: GitRepositorySnapshot | null) {
  if (snapshot?.available !== true) {
    return { label: 'Git unavailable', title: snapshot?.message || 'Git is unavailable for this workspace.' };
  }
  if (snapshot.detached === true) {
    return { label: `Detached · ${snapshot.head || 'HEAD'}`, title: `Detached HEAD: ${snapshot.head || 'unknown commit'}` };
  }
  return snapshot.head
    ? { label: snapshot.head, title: `Current Git branch: ${snapshot.head}` }
    : { label: 'No branch', title: 'No committed Git branch is available yet.' };
}
