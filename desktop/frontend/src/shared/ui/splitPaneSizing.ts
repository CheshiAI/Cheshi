import type { SplitLayoutNode } from './splitPaneModel';

export const SPLIT_SEPARATOR_TRACK_SIZE = 1;
export const SPLIT_PANE_MIN_SIZE = 120;
export type SplitPaneMinimumWidth = number | ((paneId: string) => number);

/** Include every leaf and separator when a branch must fit side by side. */
export function splitPaneMinimumWidth(layout: SplitLayoutNode, paneWidth: SplitPaneMinimumWidth): number {
  if (layout.type === 'pane') return typeof paneWidth === 'function' ? paneWidth(layout.paneId) : paneWidth;
  const first = splitPaneMinimumWidth(layout.first, paneWidth);
  const second = splitPaneMinimumWidth(layout.second, paneWidth);
  return layout.axis === 'columns' ? first + SPLIT_SEPARATOR_TRACK_SIZE + second : Math.max(first, second);
}
