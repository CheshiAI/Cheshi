import { expect, test } from 'bun:test';

import type { GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import { createGitWorkspaceControllerHarness } from './git-workspace-controller-test-harness';

const branch = 'feature/chat-message-surface';

function createScenario(changes: GitRepositorySnapshot['changes']) {
  let snapshot: GitRepositorySnapshot = {
    available: true, message: '', head: branch, detached: false,
    upstream: null, ahead: 0, behind: 0,
    pullRequestBase: 'main', pullRequestAhead: 0, changes,
  };
  const harness = createGitWorkspaceControllerHarness({
    getGitSnapshot: async () => snapshot,
    fetchGitRepository: async () => ({ output: '', snapshot }),
    listGitHubPullRequests: async () => ({ available: true, message: '', pullRequests: [] }),
  });
  return {
    ...harness,
    async openPullRequests() {
      harness.render().selectTab('pull-requests');
      harness.flushEffects();
      harness.render();
      harness.flushEffects();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return harness.render();
    },
    async commitLocally() {
      snapshot = { ...snapshot, changes: [], pullRequestAhead: 1 };
      await harness.render().refreshRepository();
      return harness.render();
    },
  };
}

for (const staged of [false, true]) {
  test(`requests a commit before pushing a new branch with ${staged ? 'staged' : 'unstaged'} changes`, async () => {
    const scenario = createScenario([{
      path: 'ChatView.module.css', oldPath: null,
      indexStatus: staged ? 'M' : ' ', workingTreeStatus: staged ? ' ' : 'M',
      staged, unstaged: !staged, untracked: false,
    }]);
    try {
      const before = await scenario.openPullRequests();
      expect(before.pullRequestHasNoCommits).toBe(true);
      expect(before.pullRequestEmptyMessage).toBe(`Commit local changes before creating a pull request from ${branch}.`);

      const after = await scenario.commitLocally();
      expect(after.snapshot.upstream).toBeNull();
      expect(after.pullRequestHasNoCommits).toBe(false);
      expect(after.pullRequestNeedsPush).toBe(true);
      expect(after.pullRequestEmptyMessage).toBe(`Push ${branch} before creating a pull request.`);
    } finally {
      scenario.dispose();
    }
  });
}

test('a clean new branch with no unique commits is already included in the base', async () => {
  const scenario = createScenario([]);
  try {
    const controller = await scenario.openPullRequests();
    expect(controller.pullRequestHasNoCommits).toBe(true);
    expect(controller.pullRequestEmptyMessage).toBe(`${branch} is already included in main.`);
  } finally {
    scenario.dispose();
  }
});
