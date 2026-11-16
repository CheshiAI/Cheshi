import { isLiteralTrue } from '../../shared/isLiteralTrue.ts';
import type { GitDiscardTarget, GitFileChange } from '../../cheshiDesktop';

export function checkedGitDiscardTargets(
  changes: readonly Pick<GitFileChange, 'path' | 'staged'>[],
): GitDiscardTarget[] {
  return changes
    .filter((change) => isLiteralTrue(change.staged))
    .map((change) => ({ path: change.path, scope: 'staged' }));
}

export function gitChangeKey(target: GitDiscardTarget): string {
  return `${target.scope}\0${target.path}`;
}

/** Follow a file to its other group only when its previous row no longer exists. */
export function reconcileGitChangeSelection(
  selected: GitDiscardTarget[], targets: readonly GitDiscardTarget[],
): GitDiscardTarget[] {
  const available = new Map(targets.map(target => [gitChangeKey(target), target]));
  const byPath = new Map(targets.map(target => [target.path, target]));
  const retained = new Map<string, GitDiscardTarget>();
  for (const target of selected) {
    const next = available.get(gitChangeKey(target)) ?? byPath.get(target.path);
    if (next) retained.set(gitChangeKey(next), next);
  }
  const next = [...retained.values()];
  return next.length === selected.length && next.every((target, index) => gitChangeKey(target) === gitChangeKey(selected[index]!))
    ? selected : next;
}

export function selectGitChanges({
  targets, selected, target, anchor, toggle, range,
}: {
  targets: GitDiscardTarget[];
  selected: GitDiscardTarget[];
  target: GitDiscardTarget;
  anchor: GitDiscardTarget | null;
  toggle: boolean;
  range: boolean;
}): GitDiscardTarget[] {
  const key = gitChangeKey(target);
  if (range && anchor) {
    const start = targets.findIndex((item) => gitChangeKey(item) === gitChangeKey(anchor));
    const end = targets.findIndex((item) => gitChangeKey(item) === key);
    if (start !== -1 && end !== -1) {
      const selection = targets.slice(Math.min(start, end), Math.max(start, end) + 1);
      return toggle
        ? [...new Map([...selected, ...selection].map((item) => [gitChangeKey(item), item])).values()]
        : selection;
    }
  }
  if (!toggle) return [target];
  return selected.some((item) => gitChangeKey(item) === key)
    ? selected.filter((item) => gitChangeKey(item) !== key)
    : [...selected, target];
}
