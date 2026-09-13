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
