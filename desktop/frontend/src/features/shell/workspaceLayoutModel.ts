import { cheshiDesktop } from '../../cheshiDesktop';
import { insertSplitPane, removeSplitPane, splitPaneIds, type SplitLayoutNode, type SplitPaneDirection } from '../../shared/ui/splitPaneModel';

export type WorkspacePaneId = 'primary' | 'editor' | 'terminal';
export type WorkspaceSplitTarget = WorkspacePaneId | 'workspace';
const paneIds: readonly string[] = ['primary', 'editor', 'terminal'];

export type LayoutMode = 'primary' | 'split' | 'editor' | 'page';
export function visibleWorkspaceLayout(mode: LayoutMode, terminalPrimary: boolean, ratio = .5): SplitLayoutNode {
  const primary: SplitLayoutNode = { type: 'pane', paneId: terminalPrimary ? 'terminal' : 'primary' };
  if (mode === 'primary' || mode === 'page') return primary;
  if (mode === 'editor') return { type: 'pane', paneId: 'editor' };
  return { type: 'split', id: 'workspace-editor', axis: 'columns', ratio,
    first: { type: 'pane', paneId: 'editor' }, second: primary };
}

export function placeWorkspacePane(layout: SplitLayoutNode, target: WorkspaceSplitTarget,
  paneId: WorkspacePaneId, direction: SplitPaneDirection): SplitLayoutNode {
  if (target === paneId) return layout;
  const remaining = removeSplitPane(layout, paneId);
  if (!remaining) return layout;
  if (target !== 'workspace' && !splitPaneIds(remaining).includes(target)) return layout;
  if (target === 'workspace') {
    const pane: SplitLayoutNode = { type: 'pane', paneId };
    const before = direction === 'left' || direction === 'up';
    return { type: 'split', id: `workspace-${paneId}`, axis: direction === 'right' || direction === 'left' ? 'columns' : 'rows',
      ratio: 0.5, first: before ? pane : remaining, second: before ? remaining : pane };
  }
  return insertSplitPane(remaining, target, paneId, direction, `workspace-${paneId}`);
}

/** Keep the center neutral so crossing a pane does not accidentally select a drop. */
export function workspaceDropDirection(bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  clientX: number, clientY: number): SplitPaneDirection | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (clientX - bounds.left) / bounds.width, y = (clientY - bounds.top) / bounds.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const edges: [SplitPaneDirection, number][] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
  const nearest = edges.reduce((best, edge) => edge[1] < best[1] ? edge : best);
  return nearest[1] <= .3 ? nearest[0] : null;
}

export function revealWorkspacePane(layout: SplitLayoutNode, paneId: WorkspacePaneId): SplitLayoutNode {
  return splitPaneIds(layout).includes(paneId) ? layout : placeWorkspacePane(layout, 'workspace', paneId, 'right');
}

export function parseWorkspaceLayout(value: unknown): SplitLayoutNode | null {
  const seen = new Set<string>();
  const splits = new Set<string>();
  const parse = (input: unknown, depth: number): SplitLayoutNode | null => {
    if (!input || typeof input !== 'object' || depth > 2) return null;
    const node = input as Record<string, unknown>;
    if (node.type === 'pane') {
      if (typeof node.paneId !== 'string' || !paneIds.includes(node.paneId) || seen.has(node.paneId)) return null;
      seen.add(node.paneId);
      return { type: 'pane', paneId: node.paneId };
    }
    if (node.type !== 'split' || typeof node.id !== 'string' || !node.id || splits.has(node.id)
      || (node.axis !== 'columns' && node.axis !== 'rows') || typeof node.ratio !== 'number'
      || !Number.isFinite(node.ratio) || node.ratio < .1 || node.ratio > .9) return null;
    splits.add(node.id);
    const first = parse(node.first, depth + 1), second = parse(node.second, depth + 1);
    return first && second ? { type: 'split', id: node.id, axis: node.axis, ratio: node.ratio, first, second } : null;
  };
  return parse(value, 0);
}

function key() { return `cheshi:workspace-layout:${cheshiDesktop?.workspaceRoot ?? ''}`; }
export function readWorkspaceLayout(): SplitLayoutNode | null {
  try { return parseWorkspaceLayout(JSON.parse(window.localStorage.getItem(key()) ?? 'null')); }
  catch { return null; }
}
export function saveWorkspaceLayout(layout: SplitLayoutNode | null) {
  try {
    if (layout) window.localStorage.setItem(key(), JSON.stringify(layout));
    else window.localStorage.removeItem(key());
  } catch { /* Layout controls remain usable when storage is unavailable. */ }
}
