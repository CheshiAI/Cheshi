import { setTimeout as delay } from 'node:timers/promises';
import { GitCommandError } from './git-command.mts';
import type { normalizePullRequestMergeState } from './github-pull-request-data.mts';

type MergeState = ReturnType<typeof normalizePullRequestMergeState>;

export async function waitForPullRequestMergeState(
  readState: () => Promise<MergeState>,
  wait: (milliseconds: number) => Promise<unknown> = delay,
  refreshCalculation?: () => Promise<unknown>,
) {
  const initial = await readState();
  let state = initial;
  const retryDelays = [1000, 2000, 3000, 4000, 5000, 5000];
  for (const [retry, milliseconds] of retryDelays.entries()) {
    const calculating = state.mergeable === 'UNKNOWN' || state.mergeStateStatus === 'UNKNOWN';
    const blocked = state.draft || state.mergeable === 'CONFLICTING'
      || ['DRAFT', 'DIRTY', 'BLOCKED', 'BEHIND', 'UNSTABLE'].includes(state.mergeStateStatus);
    if (!calculating || blocked) break;
    if (retry === 0) await refreshCalculation?.();
    await wait(milliseconds);
    state = await readState();
    if (state.headRefOid !== initial.headRefOid || state.baseRefName !== initial.baseRefName) {
      throw new GitCommandError('This pull request changed while checking mergeability. Review it again before merging.');
    }
  }
  return state;
}
