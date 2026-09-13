import { expect, test } from 'bun:test';

import type { GitDiffResult, GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';
import { createGitWorkspaceControllerHarness } from './git-workspace-controller-test-harness';

const path = 'commit-test.md';
const emptyPatch = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..e69de29\n`;
const contentPatch = `${emptyPatch}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+saved content\n`;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function createScenario(staged = false) {
  const snapshot: GitRepositorySnapshot = {
    available: true,
    message: '',
    changes: [{
      path, oldPath: null, indexStatus: staged ? 'A' : '?',
      workingTreeStatus: staged ? ' ' : '?', staged, unstaged: !staged, untracked: !staged,
    }],
  };
  const requests: Array<ReturnType<typeof createDeferred<GitDiffResult>>> = [];
  let repositoryChanged = () => {};
  const harness = createGitWorkspaceControllerHarness({
    getGitSnapshot: async () => snapshot,
    fetchGitRepository: async () => ({ output: '', snapshot }),
    onGitRepositoryChanged(callback) {
      repositoryChanged = callback;
      return () => { repositoryChanged = () => {}; };
    },
    getGitDiff() {
      const request = createDeferred<GitDiffResult>();
      requests.push(request);
      return request.promise;
    },
  });
  const pump = async () => {
    harness.render();
    harness.flushEffects();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return harness.render();
  };
  const resolveDiff = (index: number, patch: string) => {
    requests[index]!.resolve({
      scope: staged ? 'staged' : 'working', path, commit: null, patch, truncated: false, binary: false,
    });
  };
  return { ...harness, requests, pump, resolveDiff, changed: () => repositoryChanged() };
}

for (const staged of [false, true]) {
  test(`refreshes ${staged ? 'staged' : 'untracked'} content when status and selection are unchanged`, async () => {
    const scenario = createScenario(staged);
    try {
      await scenario.pump();
      await scenario.pump();
      scenario.resolveDiff(0, emptyPatch);
      const initial = await scenario.pump();
      expect(initial.diff?.patch).toBe(emptyPatch);

      await initial.refreshRepository();
      await scenario.pump();
      expect(scenario.requests).toHaveLength(2);
      scenario.resolveDiff(1, contentPatch);
      const refreshed = await scenario.pump();
      expect(refreshed.selection).toBe(initial.selection);
      expect(refreshed.diff?.patch).toBe(contentPatch);
      expect(refreshed.diffFiles[0]?.additions).toBe(1);

      scenario.changed();
      await scenario.pump();
      await scenario.pump();
      expect(scenario.requests).toHaveLength(3);
    } finally {
      scenario.dispose();
    }
  });
}

test('discards an older diff response after a repository refresh', async () => {
  const scenario = createScenario();
  try {
    await scenario.pump();
    await scenario.pump();
    await scenario.render().refreshRepository();
    await scenario.pump();
    expect(scenario.requests).toHaveLength(2);
    scenario.resolveDiff(1, contentPatch);
    await scenario.pump();
    scenario.resolveDiff(0, emptyPatch);
    expect((await scenario.pump()).diff?.patch).toBe(contentPatch);
  } finally {
    scenario.dispose();
  }
});

test('keeps an immutable commit diff during repository refresh', async () => {
  const scenario = createScenario();
  try {
    await scenario.pump();
    scenario.render().setSelection({ scope: 'commit', path, commit: 'abcdef1' });
    await scenario.pump();
    const calls = scenario.requests.length;
    await scenario.render().refreshRepository();
    await scenario.pump();
    expect(scenario.requests).toHaveLength(calls);
  } finally {
    scenario.dispose();
  }
});
