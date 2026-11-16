import { removeSplitPane, splitPaneIds, type SplitLayoutNode } from '../../shared/ui/splitPaneModel';

export interface EditorPaneSession {
  layout: SplitLayoutNode;
  activeId: string;
  groups: Record<string, { paths: string[]; selectedPath: string | null; problemsOpen?: boolean; problemsRatio?: number }>;
}

export function parseEditorPaneSession(value: unknown): EditorPaneSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<EditorPaneSession>;
  const ids = new Set<string>();
  const splits = new Set<string>();
  const parseNode = (node: unknown, depth: number): node is SplitLayoutNode => {
    if (!node || typeof node !== 'object' || depth > 16) return false;
    const n = node as SplitLayoutNode;
    if (n.type === 'pane') {
      if (typeof n.paneId !== 'string' || !/^editor-[\w-]+$/.test(n.paneId) || ids.has(n.paneId) || ids.size >= 32) return false;
      ids.add(n.paneId);
      return true;
    }
    if (n.type !== 'split' || typeof n.id !== 'string' || splits.has(n.id)
      || !['columns', 'rows'].includes(n.axis) || !Number.isFinite(n.ratio) || n.ratio < .1 || n.ratio > .9) return false;
    splits.add(n.id);
    return parseNode(n.first, depth + 1) && parseNode(n.second, depth + 1);
  };
  if (!parseNode(record.layout, 0) || !record.groups || !ids.has(record.activeId ?? '')) return null;
  const groups: EditorPaneSession['groups'] = {};
  for (const id of ids) {
    const group = record.groups[id];
    if (!group || !Array.isArray(group.paths) || group.paths.length > 500
      || group.paths.some(path => typeof path !== 'string' || !path || path.includes('\0'))
      || new Set(group.paths).size !== group.paths.length
      || (group.selectedPath !== null && !group.paths.includes(group.selectedPath))
      || (group.problemsOpen !== undefined && typeof group.problemsOpen !== 'boolean')
      || (group.problemsRatio !== undefined && (!Number.isFinite(group.problemsRatio) || group.problemsRatio < 0 || group.problemsRatio > 1))) return null;
    groups[id] = { paths: [...group.paths], selectedPath: group.selectedPath,
      problemsOpen: group.problemsOpen, problemsRatio: group.problemsRatio };
  }
  return { layout: record.layout, activeId: record.activeId!, groups };
}

export function pruneEditorPaneLayout(layout: SplitLayoutNode, keep: Set<string>): SplitLayoutNode | null {
  let next: SplitLayoutNode | null = layout;
  for (const id of splitPaneIds(layout)) if (!keep.has(id) && next) next = removeSplitPane(next, id);
  return next;
}
