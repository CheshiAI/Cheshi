import { describe, expect, test } from 'bun:test';

import {
  insertSplitPane,
  removeSplitPane,
  resizeSplitPane,
  splitPaneIds,
  type SplitLayoutNode,
  type SplitPaneDirection,
} from '../frontend/src/shared/ui/splitPaneModel';
import { insertTerminalPane, removeTerminalPane, resizeTerminalSplit } from '../lib/terminal-controller.mts';

const initial: SplitLayoutNode = { type: 'pane', paneId: 'first' };

describe('shared split layout', () => {
  test('preserves terminal ordering, axes and collapse behavior through nested edits', () => {
    let layout: SplitLayoutNode = initial;
    let terminal = insertTerminalPane(initial, 'missing', 'unused', 'right', 'unused');
    const directions: SplitPaneDirection[] = ['right', 'down', 'left', 'up'];
    for (const [index, direction] of directions.entries()) {
      const paneId = `pane-${index}`;
      const splitId = `split-${index}`;
      layout = insertSplitPane(layout, 'first', paneId, direction, splitId);
      terminal = insertTerminalPane(terminal, 'first', paneId, direction, splitId);
      expect<SplitLayoutNode | null>(layout).toEqual(terminal);
    }
    expect(splitPaneIds(layout)).toEqual(['pane-2', 'pane-3', 'first', 'pane-1', 'pane-0']);
    layout = resizeSplitPane(layout, 'split-1', 0.7);
    terminal = resizeTerminalSplit(terminal, 'split-1', 0.7);
    expect<SplitLayoutNode | null>(layout).toEqual(terminal);
    expect(removeSplitPane(layout, 'first')).toEqual(removeTerminalPane(terminal, 'first'));
  });

  test('leaves unrelated branches and nonexistent targets unchanged', () => {
    const layout = insertSplitPane(initial, 'first', 'second', 'right', 'root');
    expect(insertSplitPane(layout, 'missing', 'third', 'down', 'unused')).toBe(layout);
    expect(removeSplitPane(layout, 'missing')).toBe(layout);
    expect(resizeSplitPane(layout, 'missing', 0.6)).toBe(layout);
    if (layout.type !== 'split') throw new Error('Expected split layout');
    const changed = insertSplitPane(layout, 'second', 'third', 'down', 'nested');
    if (changed.type !== 'split') throw new Error('Expected split layout');
    expect(changed.first).toBe(layout.first);
    expect(removeSplitPane(changed, 'third')).toEqual(layout);
  });

  test('rejects invalid resize ratios and handles last pane removal', () => {
    const layout = insertSplitPane(initial, 'first', 'second', 'right', 'root');
    for (const ratio of [NaN, Infinity, -0.1, 0.09, 0.91, 1]) {
      expect(resizeSplitPane(layout, 'root', ratio)).toBe(layout);
    }
    expect(resizeSplitPane(layout, 'root', 0.5)).toBe(layout);
    expect(removeSplitPane(initial, 'first')).toBeNull();
    expect(splitPaneIds(null)).toEqual([]);
  });
});
