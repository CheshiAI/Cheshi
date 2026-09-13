export function confirmWorkspaceTabsClose<T extends { path: string }>(
  tabs: readonly T[],
  isDirty: (tab: T) => boolean,
  confirmDiscard: (path: string) => boolean,
): boolean {
  return tabs.every((tab) => !isDirty(tab) || confirmDiscard(tab.path));
}
