export function reorderWorkspaceTabs<T extends { path: string }>(
  tabs: T[], source: string, target: string, side: 'before' | 'after',
): T[] {
  const sourceIndex = tabs.findIndex(tab => tab.path === source);
  const targetIndex = tabs.findIndex(tab => tab.path === target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return tabs;
  const insertionIndex = targetIndex + (side === 'after' ? 1 : 0);
  const destination = insertionIndex - (sourceIndex < insertionIndex ? 1 : 0);
  if (destination === sourceIndex) return tabs;
  const reordered = [...tabs];
  const [tab] = reordered.splice(sourceIndex, 1);
  reordered.splice(destination, 0, tab!);
  return reordered;
}
