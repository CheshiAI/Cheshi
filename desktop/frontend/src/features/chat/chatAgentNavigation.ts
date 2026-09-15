/** Keep only the current pane's agent navigation path, without conversation contents. */
export function recordAgentNavigation(path: readonly string[], sourceId: string | null, targetId: string): string[] {
  const currentPath = path.at(-1) === sourceId ? path : sourceId ? [sourceId] : [];
  const existingIndex = currentPath.indexOf(targetId);
  return existingIndex >= 0 ? currentPath.slice(0, existingIndex + 1) : [...currentPath, targetId];
}

export function previousAgentThread(path: readonly string[], currentId: string | null): string | null {
  return path.at(-1) === currentId ? path.at(-2) ?? null : null;
}
