import type { SplitLayoutNode } from './splitPaneModel';

export const SPLIT_SEPARATOR_TRACK_SIZE = 1;

/** Include every leaf and separator when a branch must fit side by side. */
export function splitPaneMinimumWidth(layout: SplitLayoutNode, paneWidth: number): number {
  if (layout.type === 'pane') return paneWidth;
  const first = splitPaneMinimumWidth(layout.first, paneWidth);
  const second = splitPaneMinimumWidth(layout.second, paneWidth);
  return layout.axis === 'columns' ? first + SPLIT_SEPARATOR_TRACK_SIZE + second : Math.max(first, second);
}
