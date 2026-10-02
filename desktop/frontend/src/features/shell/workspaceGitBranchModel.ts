import type { GitRepositorySnapshot } from '../../cheshiDesktop';
export { observeWorkspaceGitStatus as observeWorkspaceGitBranch } from '../../shared/workspaceGitStatus';

export function workspaceGitFileCounts(snapshot: GitRepositorySnapshot | null) {
  const deletedByPath = new Map<string, boolean>();
  if (snapshot?.available === true) {
    for (const change of snapshot.changes ?? []) {
      if (change.staged !== true && change.unstaged !== true && change.untracked !== true) continue;
      const deleted = change.untracked !== true && (change.indexStatus === 'D' || change.workingTreeStatus === 'D');
      // A recreated, untracked file can share a path with its staged deletion.
      deletedByPath.set(change.path, (deletedByPath.get(change.path) ?? true) && deleted);
    }
  }
  const deleted = [...deletedByPath.values()].filter(value => value).length;
  return { changed: deletedByPath.size - deleted, deleted };
}

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
