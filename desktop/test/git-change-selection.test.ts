import { expect, test } from 'bun:test';
import type { GitDiscardTarget } from '../shared/git-discard';
import { reconcileGitChangeSelection } from '../frontend/src/features/git/gitChangeSelection';

const working: GitDiscardTarget = { path: 'one.ts', scope: 'working' };
const staged: GitDiscardTarget = { path: 'one.ts', scope: 'staged' };
const other: GitDiscardTarget = { path: 'other.ts', scope: 'working' };

test('selection follows moved rows in both directions while retaining other selected files', () => {
  const stagedSelection = reconcileGitChangeSelection([working, other], [staged, other]);
  expect(stagedSelection).toEqual([staged, other]);
  expect(reconcileGitChangeSelection(stagedSelection, [working, other])).toEqual([working, other]);
});

test('partially staged files retain the selected scope and collapsing two selected scopes deduplicates the row', () => {
  const selected = [working];
  expect(reconcileGitChangeSelection(selected, [working, staged])).toBe(selected);
  expect(reconcileGitChangeSelection([working, staged], [working, staged])).toEqual([working, staged]);
  expect(reconcileGitChangeSelection([working, staged], [staged])).toEqual([staged]);
});

test('removed changes are forgotten and unchanged selection keeps its identity', () => {
  const selected = [working, other];
  expect(reconcileGitChangeSelection(selected, [working, other])).toBe(selected);
  const retained = reconcileGitChangeSelection(selected, [other]);
  expect(retained).toEqual([other]);
  expect(reconcileGitChangeSelection(retained, [working, other])).toBe(retained);
});
