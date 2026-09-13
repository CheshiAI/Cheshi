import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

import type {
  GitHubPullRequestBranchCleanupStatus,
  GitHubPullRequestSummary,
  GitRepositorySnapshot,
} from '../frontend/src/cheshiDesktop';
import { createGitWorkspaceControllerHarness } from './git-workspace-controller-test-harness';

const branch = 'feature/chat-message-surface';
const pullRequest: GitHubPullRequestSummary = {
  number: 13, title: 'Align chat cards', url: 'https://github.com/example/cheshi/pull/13',
  headRefName: branch, baseRefName: 'main', author: 'developer',
  updatedAt: '2026-09-08T10:00:00Z', draft: false, reviewDecision: null, changedFiles: 1,
};

function createScenario(pushError?: string) {
  let snapshot: GitRepositorySnapshot = {
    available: true, message: '', head: branch, detached: false,
    upstream: `origin/${branch}`, upstreamPublished: true, ahead: 0, behind: 0,
    pullRequestBase: 'main', pullRequestAhead: 0, changes: [],
  };
  let cleanup: GitHubPullRequestBranchCleanupStatus = {
    number: 13, branch, baseBranch: 'main', currentBranch: branch,
    upstream: `origin/${branch}`, state: 'remote-branch-present',
    canCleanup: false, canPush: false, branchAhead: 0, baseAhead: 0, baseBehind: 1,
    localBranchExists: true, message: 'The remote branch still exists.', snapshot,
  };
  let merged = false;
  let pushes = 0;
  let deletions = 0;
  const cleanupRequests: number[] = [];
  let repositoryChanged: (() => void) | undefined;
  const harness = createGitWorkspaceControllerHarness({
    getGitSnapshot: async () => snapshot,
    fetchGitRepository: async () => ({ output: '', snapshot }),
    listGitHubPullRequests: async () => ({
      available: true, message: '', pullRequests: merged ? [] : [pullRequest],
    }),
    mergeGitHubPullRequest: async (request) => {
      merged = true;
      return { ...request, headRefName: branch, branchDeletionAvailable: true, output: '' };
    },
    getGitHubPullRequestBranchCleanupStatus: async (number) => {
      cleanupRequests.push(number);
      return { ...cleanup, snapshot };
    },
    onGitRepositoryChanged: (listener) => {
      repositoryChanged = listener;
      return () => { repositoryChanged = undefined; };
    },
    commitGitChanges: async () => {
      setLocalCommit();
      return { output: '', snapshot };
    },
    pushGitCurrentBranch: async () => {
      pushes += 1;
      if (pushError) throw new Error(pushError);
      snapshot = { ...snapshot, ahead: 0 };
      return { output: '', snapshot };
    },
    deleteGitHubPullRequestBranch: async (number) => {
      deletions += 1;
      return { number, branch, baseBranch: 'main', output: '', refreshWarning: null, cleanup, snapshot };
    },
  });
  function setLocalCommit() {
    snapshot = { ...snapshot, ahead: 1, pullRequestAhead: 1, changes: [] };
    cleanup = {
      ...cleanup, state: 'local-commits-after-merge', branchAhead: 1, canPush: true,
      message: 'Push the new local commit before creating another pull request.', snapshot,
    };
  }
  return {
    ...harness,
    cleanupRequests,
    get pushes() { return pushes; },
    get deletions() { return deletions; },
    setLocalCommit,
    setDirty() {
      snapshot = { ...snapshot, changes: [{
        path: 'ChatView.module.css', oldPath: null, indexStatus: ' ', workingTreeStatus: 'M',
        staged: false, unstaged: true, untracked: false,
      }] };
      cleanup = { ...cleanup, state: 'worktree-dirty', canPush: false,
        message: 'Commit local changes before deleting the branch.', snapshot };
    },
    async notifyRepositoryChanged() {
      repositoryChanged?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return harness.render();
    },
    async merge() {
      harness.render().selectTab('pull-requests');
      harness.flushEffects();
      harness.render();
      harness.flushEffects();
      await new Promise<void>((resolve) => setImmediate(resolve));
      harness.render().beginMerge(pullRequest);
      await harness.render().mergePullRequest();
      return harness.render();
    },
  };
}

test('checks local branch status immediately after merging while the remote branch remains', async () => {
  const scenario = createScenario();
  try {
    const controller = await scenario.merge();
    expect(scenario.cleanupRequests).toEqual([13]);
    expect(controller.mergedPullRequest?.branchDeleted).toBe(false);
    expect(controller.mergedPullRequest?.cleanup?.state).toBe('remote-branch-present');
  } finally {
    scenario.dispose();
  }
});

test('refreshes dirty branch status before remote deletion', async () => {
  const scenario = createScenario();
  try {
    await scenario.merge();
    scenario.setDirty();
    await scenario.render().refreshRepository();
    const controller = scenario.render();
    expect(controller.mergedPullRequest?.branchDeleted).toBe(false);
    expect(controller.mergedPullRequest?.cleanup?.state).toBe('worktree-dirty');
    expect(controller.mergedPullRequest?.cleanup?.canPush).toBe(false);
    await controller.deleteMergedPullRequestBranch();
    expect(scenario.deletions).toBe(0);
  } finally {
    scenario.dispose();
  }
});

test('discovers an external commit from repository events while the merged remote branch remains', async () => {
  const scenario = createScenario();
  try {
    await scenario.merge();
    scenario.setLocalCommit();
    const controller = await scenario.notifyRepositoryChanged();
    expect(controller.mergedPullRequest?.branchDeleted).toBe(false);
    expect(controller.mergedPullRequest?.cleanup?.canPush).toBe(true);
    expect(controller.mergedPullRequest?.cleanup?.branchAhead).toBe(1);
    await controller.deleteMergedPullRequestBranch();
    expect(scenario.deletions).toBe(0);
  } finally {
    scenario.dispose();
  }
});

test('refreshes merged branch actions after creating a local commit', async () => {
  const scenario = createScenario();
  try {
    await scenario.merge();
    scenario.render().setCommitMessage('[fix] update chat cards');
    await scenario.render().commit();
    const controller = scenario.render();
    expect(controller.mergedPullRequest?.branchDeleted).toBe(false);
    expect(controller.mergedPullRequest?.cleanup?.canPush).toBe(true);
    expect(controller.snapshot.ahead).toBe(1);
  } finally {
    scenario.dispose();
  }
});

for (const pushError of [undefined, 'Push rejected']) {
  test(`pushing new commits on a merged branch ${pushError ? 'preserves recovery state on failure' : 'clears the merged screen on success'}`, async () => {
    const scenario = createScenario(pushError);
    try {
      await scenario.merge();
      scenario.setLocalCommit();
      await scenario.notifyRepositoryChanged();
      await scenario.render().pushMergedPullRequestBranch();
      const controller = scenario.render();
      expect(scenario.pushes).toBe(1);
      if (pushError) {
        expect(controller.error).toBe(pushError);
        expect(controller.mergedPullRequest?.branchDeleted).toBe(false);
        expect(controller.mergedPullRequest?.cleanup?.canPush).toBe(true);
      } else {
        expect(controller.mergedPullRequest).toBeNull();
        expect(controller.error).toBeNull();
        expect(controller.snapshot.ahead).toBe(0);
      }
    } finally {
      scenario.dispose();
    }
  });
}

interface TestElement {
  type: unknown;
  props: { children?: unknown; disabled?: boolean };
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('props' in value) || !('type' in value)) return [];
  const element = value as TestElement;
  return [element, ...elements(element.props.children)];
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  const [element] = elements(value);
  return element ? textContent(element.props.children) : '';
}

function renderMergedActions(controller: ReturnType<ReturnType<typeof createScenario>['render']>) {
  const source = readFileSync(new URL('../frontend/src/features/git/GitPullRequestPanels.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const exports: Record<string, unknown> = {};
  const jsx = (type: unknown, props: TestElement['props']): unknown => (
    typeof type === 'function' ? type(props) : { type, props }
  );
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_target, name) => String(name) }),
    '../../shared/ui': { NeumorphicButton: 'button' },
    './gitWorkspaceModel': {},
    './GitWorkspace.module.css': { default: {} },
  };
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected component dependency: ${name}`);
      return modules[name];
    },
  });
  const component = exports.MergedPullRequestDetail;
  if (typeof component !== 'function') throw new Error('Merged pull request component is unavailable.');
  return elements(component({
    busy: false, checkingCleanup: false, cleaningBranch: false, deletingBranch: false, pushingBranch: false,
    hasLocalChanges: controller.changes.length > 0, mergedPullRequest: controller.mergedPullRequest,
    onCleanupBranch() {}, onDeleteBranch() {}, onPushBranch() {},
  })).filter((element) => element.type === 'button' && textContent(element.props.children));
}

test('renders a push action instead of deletion for new commits before the remote branch is deleted', async () => {
  const scenario = createScenario();
  try {
    await scenario.merge();
    scenario.setLocalCommit();
    const controller = await scenario.notifyRepositoryChanged();
    const buttons = renderMergedActions(controller);
    expect(buttons.map((button) => textContent(button.props.children))).toEqual([`Push ${branch}`]);
    expect(buttons[0]?.props.disabled).toBe(false);
  } finally {
    scenario.dispose();
  }
});

test('renders a disabled delete action while uncommitted work remains', async () => {
  const scenario = createScenario();
  try {
    await scenario.merge();
    scenario.setDirty();
    const controller = await scenario.notifyRepositoryChanged();
    const buttons = renderMergedActions(controller);
    expect(buttons.map((button) => textContent(button.props.children))).toEqual(['Delete branch']);
    expect(buttons[0]?.props.disabled).toBe(true);
  } finally {
    scenario.dispose();
  }
});
