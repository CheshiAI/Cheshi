export type SplitPaneDirection = 'right' | 'left' | 'down' | 'up';

export type SplitLayoutNode =
  | { type: 'pane'; paneId: string }
  | {
      type: 'split';
      id: string;
      axis: 'columns' | 'rows';
      ratio: number;
      first: SplitLayoutNode;
      second: SplitLayoutNode;
    };

export function splitPaneIds(layout: SplitLayoutNode | null): string[] {
  if (!layout) return [];
  return layout.type === 'pane'
    ? [layout.paneId]
    : [...splitPaneIds(layout.first), ...splitPaneIds(layout.second)];
}

export function insertSplitPane(
  layout: SplitLayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitPaneDirection,
  splitId: string,
): SplitLayoutNode {
  if (layout.type === 'pane') {
    if (layout.paneId !== targetPaneId) return layout;
    const inserted: SplitLayoutNode = { type: 'pane', paneId: newPaneId };
    const before = direction === 'left' || direction === 'up';
    return {
      type: 'split',
      id: splitId,
      axis: direction === 'left' || direction === 'right' ? 'columns' : 'rows',
      ratio: 0.5,
      first: before ? inserted : layout,
      second: before ? layout : inserted,
    };
  }
  const first = insertSplitPane(layout.first, targetPaneId, newPaneId, direction, splitId);
  if (first !== layout.first) return { ...layout, first };
  const second = insertSplitPane(layout.second, targetPaneId, newPaneId, direction, splitId);
  return second === layout.second ? layout : { ...layout, second };
}

export function removeSplitPane(layout: SplitLayoutNode | null, paneId: string): SplitLayoutNode | null {
  if (!layout) return null;
  if (layout.type === 'pane') return layout.paneId === paneId ? null : layout;
  const first = removeSplitPane(layout.first, paneId);
  const second = removeSplitPane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

export function resizeSplitPane(
  layout: SplitLayoutNode,
  splitId: string,
  ratio: number,
): SplitLayoutNode {
  if (layout.type === 'pane' || !Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) return layout;
  if (layout.id === splitId) return layout.ratio === ratio ? layout : { ...layout, ratio };
  const first = resizeSplitPane(layout.first, splitId, ratio);
  if (first !== layout.first) return { ...layout, first };
  const second = resizeSplitPane(layout.second, splitId, ratio);
  return second === layout.second ? layout : { ...layout, second };
}
