export function isWorkspacePathAtOrBelow(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

export function workspaceParentDirectory(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf('/');
  return separatorIndex < 0 ? '.' : relativePath.slice(0, separatorIndex);
}

export function workspaceDirectoriesAffectedByChanges(
  loadedDirectories: readonly string[],
  changedPaths: readonly string[],
  overflow: boolean,
): string[] {
  const loadedDirectorySet = new Set(loadedDirectories);
  if (overflow) return [...loadedDirectorySet];

  const affectedDirectories = new Set<string>();
  for (const changedPath of changedPaths) {
    const parentDirectory = workspaceParentDirectory(changedPath);
    if (loadedDirectorySet.has(parentDirectory)) affectedDirectories.add(parentDirectory);
    if (loadedDirectorySet.has(changedPath)) affectedDirectories.add(changedPath);
  }
  return [...affectedDirectories];
}

export function renameWorkspacePathPrefix(
  candidatePath: string,
  previousPath: string,
  nextPath: string,
): string {
  if (candidatePath === previousPath) return nextPath;
  if (!candidatePath.startsWith(`${previousPath}/`)) return candidatePath;
  return `${nextPath}${candidatePath.slice(previousPath.length)}`;
}
