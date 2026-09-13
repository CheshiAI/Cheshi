import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForPullRequestMergeState } from '../lib/github-pull-request-merge-state.mts';
import { assertPullRequestCanMerge } from '../lib/github-pull-request-data.mts';

const ready = {
  headRefOid: 'a'.repeat(40), headRefName: 'feature/test', baseRefName: 'main',
  draft: false, crossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
};
const unknown = { ...ready, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
const noWait = async () => {};

test('waits for calculation and returns the verified head', async () => {
  let reads = 0;
  const waits: number[] = [];
  const state = await waitForPullRequestMergeState(async () => ++reads < 3 ? unknown : ready,
    async (milliseconds) => { waits.push(milliseconds); });
  assert.equal(state, ready);
  assert.deepEqual(waits, [1000, 2000]);
  assert.doesNotThrow(() => assertPullRequestCanMerge(state));
});

test('limits retries and leaves unresolved mergeability blocked', async () => {
  let reads = 0;
  const state = await waitForPullRequestMergeState(async () => { reads += 1; return unknown; }, noWait);
  assert.equal(reads, 7);
  assert.throws(() => assertPullRequestCanMerge(state), /still calculating/);
});

test('does not retry ready or blocked states', async () => {
  for (const mergeStateStatus of ['CLEAN', 'DRAFT', 'DIRTY', 'BLOCKED', 'BEHIND', 'UNSTABLE']) {
    const value = { ...ready, mergeStateStatus, mergeable: mergeStateStatus === 'CLEAN' ? 'MERGEABLE' : 'UNKNOWN' };
    const state = await waitForPullRequestMergeState(async () => value, async () => { assert.fail('unexpected wait'); });
    assert.equal(state, value);
    if (mergeStateStatus !== 'CLEAN') assert.throws(() => assertPullRequestCanMerge(state));
  }
});

test('rejects changed head or base while waiting', async () => {
  for (const changed of [{ ...ready, headRefOid: 'b'.repeat(40) }, { ...ready, baseRefName: 'release' }]) {
    let reads = 0;
    await assert.rejects(waitForPullRequestMergeState(async () => ++reads === 1 ? unknown : changed, noWait), /changed while checking/);
  }
});

test('propagates lookup failures without retrying', async () => {
  await assert.rejects(waitForPullRequestMergeState(async () => { throw new Error('lookup failed'); }, noWait), /lookup failed/);
});


test('refreshes calculation once before polling and bounds total delay', async () => {
  let refreshes = 0;
  let waited = 0;
  await waitForPullRequestMergeState(async () => unknown,
    async (milliseconds) => { waited += milliseconds; },
    async () => { refreshes += 1; });
  assert.equal(refreshes, 1);
  assert.equal(waited, 20000);
});

test('skips calculation refresh for mergeable pull requests', async () => {
  await waitForPullRequestMergeState(async () => ready, noWait,
    async () => { assert.fail('unexpected refresh'); });
});
