import { expect, test } from 'bun:test';
import { parseWorkspaceLayout, placeWorkspacePane, visibleWorkspaceLayout } from '../frontend/src/features/shell/workspaceLayoutModel';
import { splitPaneIds } from '../frontend/src/shared/ui/splitPaneModel';

test('Worker is an independent default pane and four nested panes round-trip without duplicates', () => {
  const worker = visibleWorkspaceLayout('primary', false, .5, true);
  expect(splitPaneIds(worker)).toEqual(['worker']);
  let layout = placeWorkspacePane(worker, 'worker', 'primary', 'right');
  layout = placeWorkspacePane(layout, 'primary', 'editor', 'down');
  layout = placeWorkspacePane(layout, 'editor', 'terminal', 'right');
  expect(splitPaneIds(layout)).toEqual(['worker', 'primary', 'editor', 'terminal']);
  expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  const moved = placeWorkspacePane(layout, 'editor', 'worker', 'down');
  expect(splitPaneIds(moved).filter(id => id === 'worker')).toHaveLength(1);
  expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
  expect(placeWorkspacePane(moved, 'worker', 'worker', 'right')).toBe(moved);
  expect(parseWorkspaceLayout({ type: 'split', id: 'duplicate', axis: 'columns', ratio: .5,
    first: worker, second: worker })).toBeNull();
});
