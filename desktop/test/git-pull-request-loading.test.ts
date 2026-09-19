import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import type {
  GitHubPullRequestCommit, GitHubPullRequestDetails, GitHubPullRequestDiffResult,
  GitHubPullRequestListResult, GitHubPullRequestSummary,
} from '../frontend/src/cheshiDesktop.ts';
import {
  pullRequestMatchesBranch, pullRequestReviewLocation, pullRequestReviewLocationKey,
} from '../frontend/src/features/git/gitWorkspaceModel.ts';
import { parseUnifiedDiff } from '../frontend/src/features/git/unifiedDiff.ts';
import { createGitWorkspaceControllerHarness } from './git-workspace-controller-test-harness.ts';
import { normalizePullRequest } from '../lib/github-pull-request-data.mts';

interface TestElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface ActivityOptions {
  tab?: 'conversation' | 'commits' | 'changes';
  listLoading?: boolean;
  detailsLoading?: boolean;
  diffLoading?: boolean;
  diffError?: string;
  details?: GitHubPullRequestDetails | null;
  commit?: GitHubPullRequestCommit | null;
  diff?: GitHubPullRequestDiffResult;
  onSelectCommit?: (commit: GitHubPullRequestCommit) => void;
}

const selectedPullRequest: GitHubPullRequestSummary = {
  number: 12, title: 'Refresh feedback', url: 'https://example.invalid/pull/12',
  headRefName: 'feature/test', baseRefName: 'main', author: 'test-user',
  updatedAt: '2026-09-06T00:00:00Z', draft: false, reviewDecision: null, changedFiles: 1,
};

const firstCommit: GitHubPullRequestCommit = {
  oid: 'a'.repeat(40), headline: 'First commit', body: '',
  authoredAt: '2026-09-06T00:00:00Z', authors: ['test-user'],
};
const secondCommit: GitHubPullRequestCommit = { ...firstCommit, oid: 'b'.repeat(40), headline: 'Second commit' };

function emptyDetails(): GitHubPullRequestDetails {
  return {
    number: 12, id: 'pull-request', headRefOid: 'abc1234', viewerLogin: 'test-user',
    comments: [], commits: [], reviewThreads: [], pendingReview: null,
  };
}

const componentModules = new Map<string, Record<string, unknown>>();

// Evaluate the actual render branches as element data without launching a browser.
function loadComponent(filename: string): Record<string, unknown> {
  const cached = componentModules.get(filename);
  if (cached) return cached;
  const source = readFileSync(new URL(`../frontend/src/features/git/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const exports: Record<string, unknown> = {};
  const jsx = (type: unknown, props: Record<string, unknown>): unknown => (
    typeof type === 'function' ? type(props) : { type, props }
  );
  const modules: Record<string, unknown> = {
    react: {
      memo: (component: unknown) => component,
      useState: (initial: unknown) => [initial, () => {}],
      useMemo: (calculate: () => unknown) => calculate(),
      useRef: (current: unknown) => ({ current }),
      useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_target, name) => String(name) }),
    '../../shared/ui': {
      EmptyState: ({ title, description }: { title: string; description: string }) => jsx('empty-state', { children: [title, description] }),
      FilterTab: 'tab', FilterTabList: 'tabs', LiquidGlassPanel: 'panel', LiquidGlassSelect: 'select',
      LoadingState: 'loading-state',
      NeumorphicButton: 'button', NeumorphicSurface: 'surface', NeumorphicTextarea: 'textarea',
      NeumorphicTextField: 'text-field',
    },
    './GitDiffViewer': { GitDiffViewer: 'diff-viewer' },
    './GitWorkspace.module.css': { default: {} },
    './gitWorkspaceModel': {
      GITHUB_COMMENT_BODY_LIMIT: 65536, PULL_REQUEST_DETAIL_STYLE: {}, pullRequestMergeMethods: [],
      formatGitDate: (value: string) => value,
      reviewDecisionLabel: (value: string | null) => value ?? 'Pending',
      pullRequestMatchesBranch, pullRequestReviewLocation, pullRequestReviewLocationKey,
    },
  };
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      if (name === './GitPullRequestPanels') return loadComponent('GitPullRequestPanels.tsx');
      if (name === './GitDiffFileRow') return loadComponent('GitDiffFileRow.tsx');
      assert.ok(Object.hasOwn(modules, name), `Unexpected component dependency: ${name}`);
      return modules[name];
    },
  });
  componentModules.set(filename, exports);
  return exports;
}

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value
    && 'props' in value && typeof value.props === 'object' && value.props !== null;
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}

function hasLoadingState(value: unknown): boolean {
  return elements(value).some((element) => element.type === 'loading-state');
}

function visibleText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(visibleText).join(' ');
  return isElement(value) ? visibleText(value.props.children) : '';
}

function renderBranchActions(options: {
  requests?: GitHubPullRequestSummary[]; needsPush?: boolean; busy?: boolean; loading?: boolean;
  branch?: string | null; detached?: boolean; noCommits?: boolean; available?: boolean; merged?: boolean;
  operation?: 'push' | 'create' | null;
} = {}) {
  const calls: string[] = [];
  const component = loadComponent('GitPullRequestListPanel.tsx').GitPullRequestListPanel;
  assert.ok(typeof component === 'function');
  const tree = component({ controller: {
    busy: options.busy ?? false, pullRequestsLoading: options.loading ?? false,
    pullRequestOperation: options.operation ?? null,
    mergedPullRequest: options.merged ? { pullRequest: selectedPullRequest } : null,
    pullRequests: { available: options.available ?? true, message: '', pullRequests: options.requests ?? [selectedPullRequest] },
    selectedPullRequest,
    snapshot: { head: options.branch === undefined ? 'feature/local' : options.branch, detached: options.detached ?? false },
    pullRequestHasNoCommits: options.noCommits ?? false,
    pullRequestNeedsPush: options.needsPush ?? false,
    pullRequestEmptyMessage: 'Current branch status',
    pushCurrentBranch: async () => { calls.push('push'); return true; },
    createPullRequest: async () => { calls.push('create'); },
    selectPullRequest: (request: GitHubPullRequestSummary) => { calls.push(`select:${request.number}`); },
    refreshPullRequests: async () => {},
  } });
  const area = elements(tree).find(element => element.props['aria-label'] === 'Current branch');
  const action = elements(area).find(element => element.type === 'button');
  const click = () => {
    assert.ok(action && typeof action.props.onClick === 'function');
    action.props.onClick();
  };
  return { tree, area, action, calls, click };
}

test('an unrelated selected PR leaves current-branch push and creation available', () => {
  for (const needsPush of [true, false]) {
    const view = renderBranchActions({ needsPush });
    assert.ok(view.area);
    assert.equal(visibleText(view.action).trim(), needsPush ? 'Push feature/local' : 'Create pull request');
    view.click();
    assert.deepEqual(view.calls, [needsPush ? 'push' : 'create']);
    const externalRow = elements(view.tree).find(element => element.props['aria-current'] === 'true');
    assert.ok(externalRow && visibleText(externalRow).includes(selectedPullRequest.title));
  }
});

test('an existing current-branch PR is selected instead of creating a duplicate', () => {
  const current = { ...selectedPullRequest, number: 16, headRefName: 'feature/local' };
  const view = renderBranchActions({ requests: [selectedPullRequest, current] });
  assert.equal(visibleText(view.action).trim(), 'View pull request #16');
  view.click();
  assert.deepEqual(view.calls, ['select:16']);
  const ahead = renderBranchActions({ requests: [selectedPullRequest, current], needsPush: true });
  ahead.click();
  assert.deepEqual(ahead.calls, ['push']);
});

test('a same-named branch from an external fork does not hide local PR creation', () => {
  const view = renderBranchActions({ requests: [{ ...selectedPullRequest, headRefName: 'feature/local', crossRepository: true }] });
  assert.equal(visibleText(view.action).trim(), 'Create pull request');
  view.click();
  assert.deepEqual(view.calls, ['create']);
});

test('the current-branch actions remain available with an empty PR list', () => {
  for (const needsPush of [false, true]) {
    const view = renderBranchActions({ requests: [], needsPush });
    assert.ok(visibleText(view.tree).includes('No open pull requests.'));
    view.click();
    assert.deepEqual(view.calls, [needsPush ? 'push' : 'create']);
  }
});

test('branch actions retain loading, operation, detached and post-merge guards', () => {
  for (const options of [{ busy: true }, { loading: true }, { operation: 'push' as const }, { operation: 'create' as const }]) {
    const view = renderBranchActions(options);
    assert.equal(view.action?.props.disabled, true);
    view.click();
    assert.deepEqual(view.calls, []);
  }
  for (const options of [{ detached: true }, { branch: null }, { noCommits: true }, { merged: true }, { available: false }]) {
    assert.equal(renderBranchActions(options).action, undefined);
  }
});

test('PR summaries preserve literal cross-repository metadata', () => {
  const raw = { ...selectedPullRequest, url: 'https://github.com/example/project/pull/12', author: { login: 'contributor' } };
  for (const value of [true, false, 'true', 1]) {
    assert.equal(normalizePullRequest({ ...raw, isCrossRepository: value }).crossRepository, value === true);
  }
  assert.equal(normalizePullRequest(raw).crossRepository, undefined);
  assert.equal(pullRequestMatchesBranch({ ...selectedPullRequest, crossRepository: true }, selectedPullRequest.headRefName), false);
  assert.equal(pullRequestMatchesBranch({ ...selectedPullRequest, crossRepository: false }, selectedPullRequest.headRefName), true);
  assert.equal(pullRequestMatchesBranch(null, null), false);
  assert.equal(pullRequestMatchesBranch(selectedPullRequest, undefined), false);
});

function renderPanel(options: ActivityOptions = {}): unknown {
  const component = loadComponent('GitPullRequestDetailPanel.tsx').GitPullRequestDetailPanel;
  assert.ok(typeof component === 'function');
  return component({
    controller: {
      selectedPullRequest,
      pullRequestDetailTab: options.tab ?? 'conversation',
      pullRequestsLoading: options.listLoading ?? false,
      pullRequestDetailsLoading: options.detailsLoading ?? false,
      pullRequestDetails: options.details === undefined ? emptyDetails() : options.details,
      pullRequestDiffLoading: options.diffLoading ?? false,
      pullRequestDiff: options.diff ?? null, pullRequestDiffError: options.diffError ?? null,
      pullRequestDiffFiles: parseUnifiedDiff(options.diff?.patch ?? ''),
      selectedPullRequestCommit: options.commit ?? null,
      selectPullRequestCommit: options.onSelectCommit,
      pullRequestComment: '', mergeConfirmationNumber: null,
    },
  });
}

function renderActivity(options: ActivityOptions = {}): TestElement {
  const tree = renderPanel(options);
  const activity = elements(tree).find((element) => element.type === 'section'
    && element.props['data-tab'] === (options.tab ?? 'conversation'));
  assert.ok(activity, 'The selected activity panel must be present');
  return activity;
}

for (const tab of ['conversation', 'commits'] as const) {
  for (const phase of [{ listLoading: true }, { detailsLoading: true }]) {
    const request = 'listLoading' in phase ? 'list' : 'details';
    test(`${tab} shows loading while refreshing ${request} with cached empty data`, () => {
      const activity = renderActivity({ tab, ...phase });
      assert.equal(hasLoadingState(activity), true);
      assert.equal(activity.props['aria-busy'], true);
    });
  }

  test(`${tab} shows initial loading and restores its empty message after completion`, () => {
    assert.equal(hasLoadingState(renderActivity({ tab, detailsLoading: true, details: null })), true);
    const activity = renderActivity({ tab });
    assert.match(visibleText(activity), tab === 'conversation' ? /No comments yet/ : /No commits were returned/);
    assert.equal(hasLoadingState(activity), false);
    assert.equal(activity.props['aria-busy'], false);
  });

  test(`${tab} keeps existing content visible during refresh`, () => {
    const details = emptyDetails();
    details.comments.push({
      id: 'comment', author: 'test-user', body: 'Existing comment',
      createdAt: '2026-09-06T00:00:00Z', url: 'https://example.invalid/comment', viewerDidAuthor: false,
    });
    details.commits.push({
      oid: 'abc1234', headline: 'Existing commit', body: '',
      authoredAt: '2026-09-06T00:00:00Z', authors: ['test-user'],
    });
    for (const phase of [{ listLoading: true }, { detailsLoading: true }, {}]) {
      const activity = renderActivity({ tab, details, ...phase });
      assert.match(visibleText(activity), tab === 'conversation' ? /Existing comment/ : /Existing commit/);
      assert.equal(hasLoadingState(activity), false);
      assert.doesNotMatch(visibleText(activity), /No comments yet|No commits were returned/);
    }
  });
}

test('the Changes tab continues to use its own diff loading state', () => {
  for (const diffLoading of [true, false]) {
    const activity = renderActivity({ tab: 'changes', commit: firstCommit, listLoading: true, detailsLoading: true, diffLoading });
    const viewer = elements(activity).find((element) => element.type === 'diff-viewer');
    assert.ok(viewer);
    assert.equal(viewer.props.loading, diffLoading);
    assert.equal(activity.props['aria-busy'], diffLoading);
    assert.equal(hasLoadingState(activity), false);
  }
});

test('a previous diff error is hidden while a new diff is loading', () => {
  const options = { tab: 'changes' as const, commit: firstCommit, diffError: 'Previous diff request failed.' };
  const activity = renderActivity({ ...options, diffLoading: true });
  assert.ok(elements(activity).some((element) => element.type === 'diff-viewer'));
  assert.doesNotMatch(visibleText(activity), /Could not load changes/);
  assert.match(visibleText(renderActivity(options)), /Could not load changes/);
});

function diffResult(patch = '', oid = firstCommit.oid): GitHubPullRequestDiffResult {
  return { number: 12, path: null, headRefOid: oid, patch, truncated: false, binary: false };
}

const twoFilePatch = [
  'diff --git a/first.ts b/first.ts', '--- a/first.ts', '+++ b/first.ts',
  '@@ -1 +1 @@', '-previous first line', '+updated first line',
  'diff --git a/second.ts b/second.ts', '--- a/second.ts', '+++ b/second.ts',
  '@@ -1 +1 @@', '-previous second line', '+updated second line', '',
].join('\n');

function renderDiff(embedded: boolean, diff: GitHubPullRequestDiffResult | null = null): unknown {
  const component = loadComponent('GitDiffViewer.tsx').GitDiffViewer;
  assert.ok(typeof component === 'function');
  return component({
    embedded, diff, loading: true, files: parseUnifiedDiff(diff?.patch ?? ''),
    selectedPath: 'second.ts', onSelectPath() {}, onOpenWorkspaceFile() {},
  });
}

for (const embedded of [true, false]) {
  test(`${embedded ? 'embedded' : 'standalone'} diff initially shows the shared loader without a header`, () => {
    const tree = renderDiff(embedded);
    assert.ok(isElement(tree));
    assert.ok(isElement(tree.props.children));
    assert.equal(tree.props.children.type, 'loading-state');
    assert.equal(tree.props['aria-busy'], true);
    assert.equal(elements(tree).some((element) => element.type === 'header'), false);
  });
}

test('a diff refresh keeps the selected file visible with a header loading indicator', () => {
  const tree = renderDiff(true, diffResult(twoFilePatch));
  assert.match(visibleText(tree), /updated second line/);
  assert.equal(hasLoadingState(tree), false);
  assert.ok(elements(tree).some((element) => element.props['aria-label'] === 'Loading diff'));
});

test('PR review threads are not attached to unrelated lines in a selected commit', () => {
  const component = loadComponent('GitDiffViewer.tsx').GitDiffViewer;
  assert.ok(typeof component === 'function');
  for (const [commitOid, side, separate] of [
    [firstCommit.oid, 'RIGHT', false],
    [firstCommit.oid, 'LEFT', true],
    [secondCommit.oid, 'RIGHT', true],
  ] as const) {
    const details: GitHubPullRequestDetails = {
      ...emptyDetails(), headRefOid: firstCommit.oid,
      reviewThreads: [{
        id: 'thread', path: 'second.ts', line: 1, startLine: null,
        side, startSide: null, subjectType: 'LINE', resolved: false, outdated: false, comments: [],
      }],
    };
    const tree: unknown = component({
      diff: diffResult(twoFilePatch, commitOid), files: parseUnifiedDiff(twoFilePatch), loading: false,
      selectedPath: 'second.ts', onSelectPath() {},
      review: { details, commitOid, submitting: false, onAddComment: async () => false, onSubmit: async () => false },
    });
    assert.equal(visibleText(tree).includes('Pull request review comments'), separate);
  }
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestAt<T>(requests: readonly T[], index: number): T {
  const request = requests[index];
  assert.ok(request, `Expected request at index ${index}`);
  return request;
}

const settleRequests = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function createRefreshScenario(t: TestContext, initialDiff?: GitHubPullRequestDiffResult) {
  const lists: Array<ReturnType<typeof createDeferred<GitHubPullRequestListResult>>> = [];
  const details: Array<ReturnType<typeof createDeferred<GitHubPullRequestDetails>>> = [];
  const diffs: Array<ReturnType<typeof createDeferred<GitHubPullRequestDiffResult>>> = [];
  const diffCalls: Array<{ number: number; commitOid: string | undefined }> = [];
  const harness = createGitWorkspaceControllerHarness({
    listGitHubPullRequests() {
      const request = createDeferred<GitHubPullRequestListResult>();
      lists.push(request);
      return request.promise;
    },
    getGitHubPullRequestDetails() {
      const request = createDeferred<GitHubPullRequestDetails>();
      details.push(request);
      return request.promise;
    },
    getGitHubPullRequestDiff(number: number, commitOid?: string) {
      diffCalls.push({ number, commitOid });
      const request = createDeferred<GitHubPullRequestDiffResult>();
      diffs.push(request);
      return request.promise;
    },
  });
  t.after(() => harness.dispose());
  const listResult: GitHubPullRequestListResult = {
    available: true, message: '', pullRequests: [selectedPullRequest],
  };
  harness.render().selectTab('pull-requests');
  harness.flushEffects();
  harness.render();
  harness.flushEffects();
  requestAt(lists, 0).resolve(listResult);
  await settleRequests();
  harness.render();
  harness.flushEffects();
  requestAt(details, 0).resolve({ ...emptyDetails(), commits: [firstCommit, secondCommit] });
  await settleRequests();
  assert.equal(harness.render().pullRequestDetailsLoading, false);
  assert.equal(diffs.length, 0, 'Selecting a pull request must not fetch its diff.');
  if (initialDiff) {
    harness.render().selectPullRequestCommit(firstCommit);
    harness.render();
    harness.flushEffects();
    requestAt(diffs, 0).resolve(initialDiff);
    await settleRequests();
  }
  assert.equal(harness.render().pullRequestDiffLoading, false);
  return { ...harness, lists, details, diffs, diffCalls, listResult };
}

test('refresh stays loading between the list response and the details effect', async (t) => {
  const scenario = await createRefreshScenario(t);
  const refresh = scenario.render().refreshPullRequests();
  assert.equal(scenario.render().pullRequestsLoading, true);
  requestAt(scenario.lists, 1).resolve(scenario.listResult);
  await refresh;

  const betweenRequests = scenario.render();
  assert.equal(betweenRequests.pullRequestsLoading, false);
  assert.equal(betweenRequests.pullRequestDetailsLoading, true);
  const activity = renderActivity({
    details: betweenRequests.pullRequestDetails,
    detailsLoading: betweenRequests.pullRequestDetailsLoading,
  });
  assert.equal(hasLoadingState(activity), true);
  assert.doesNotMatch(visibleText(activity), /No comments yet/);

  scenario.flushEffects();
  assert.equal(scenario.render().pullRequestDetailsLoading, true);
  requestAt(scenario.details, 1).resolve(emptyDetails());
  await settleRequests();
  assert.equal(scenario.render().pullRequestDetailsLoading, false);
});

test('an older details response cannot end the loading state for a newer refresh', async (t) => {
  const scenario = await createRefreshScenario(t);
  const firstRefresh = scenario.render().refreshPullRequests();
  requestAt(scenario.lists, 1).resolve(scenario.listResult);
  await firstRefresh;
  scenario.render();
  scenario.flushEffects();

  const secondRefresh = scenario.render().refreshPullRequests('background');
  requestAt(scenario.lists, 2).resolve(scenario.listResult);
  await secondRefresh;
  // The old request settles before React cleans it up in the next passive effect.
  requestAt(scenario.details, 1).resolve(emptyDetails());
  await settleRequests();
  assert.equal(scenario.render().pullRequestDetailsLoading, true);
  scenario.flushEffects();
  requestAt(scenario.details, 2).resolve(emptyDetails());
  await settleRequests();
  assert.equal(scenario.render().pullRequestDetailsLoading, false);
});

test('a failed details refresh clears loading and exposes the error', async (t) => {
  const scenario = await createRefreshScenario(t);
  const refresh = scenario.render().refreshPullRequests();
  requestAt(scenario.lists, 1).resolve(scenario.listResult);
  await refresh;
  scenario.render();
  scenario.flushEffects();
  requestAt(scenario.details, 1).reject(new Error('Comments could not be fetched.'));
  await settleRequests();
  const controller = scenario.render();
  assert.equal(controller.pullRequestDetailsLoading, false);
  assert.equal(controller.error, 'Comments could not be fetched.');
});

test('Changes stays blank until a commit row is selected', async (t) => {
  const scenario = await createRefreshScenario(t);
  scenario.render().setPullRequestDetailTab('changes');
  scenario.render();
  scenario.flushEffects();
  assert.equal(scenario.diffs.length, 0);
  assert.equal(scenario.render().selectedPullRequestCommit, null);
  assert.equal(scenario.render().pullRequestDiffLoading, false);
  const activity = renderActivity({ tab: 'changes' });
  assert.equal(elements(activity).some((element) => element.type === 'diff-viewer'), false);
  assert.equal(visibleText(activity).trim(), '');
});

test('commit rows are buttons that select their own commit', () => {
  let selected: GitHubPullRequestCommit | null = null;
  const activity = renderActivity({
    tab: 'commits', details: { ...emptyDetails(), commits: [firstCommit, secondCommit] },
    onSelectCommit: (commit) => { selected = commit; },
  });
  const row = elements(activity).find((element) => element.type === 'button'
    && visibleText(element).includes('Second commit'));
  assert.ok(row);
  assert.equal(row.props.type, 'button');
  assert.ok(typeof row.props.onClick === 'function');
  row.props.onClick();
  assert.equal(selected, secondCommit);
});

test('Changes counts only the selected commit files and has no initial total badge', () => {
  for (const selected of [false, true]) {
    const tree = renderPanel(selected ? { commit: firstCommit, diff: diffResult(twoFilePatch) } : {});
    const tab = elements(tree).find((element) => element.type === 'tab' && visibleText(element) === 'Changes');
    assert.ok(tab);
    assert.equal(tab.props.badge, selected ? 2 : undefined);
  }
});

test('selecting a commit opens Changes and requests only that commit', async (t) => {
  const scenario = await createRefreshScenario(t);
  scenario.render().selectPullRequestCommit(secondCommit);
  const pending = scenario.render();
  assert.equal(pending.pullRequestDetailTab, 'changes');
  assert.equal(pending.selectedPullRequestCommit?.oid, secondCommit.oid);
  assert.equal(pending.pullRequestDiffLoading, true);
  assert.equal(pending.pullRequestDiff, null);
  scenario.flushEffects();
  assert.deepEqual(scenario.diffCalls, [{ number: 12, commitOid: secondCommit.oid }]);
  requestAt(scenario.diffs, 0).resolve(diffResult(twoFilePatch, secondCommit.oid));
  await settleRequests();
  assert.equal(scenario.render().pullRequestDiffFiles.length, 2);
  assert.equal(scenario.render().pullRequestDiffLoading, false);
});

test('switching commits hides the previous files before effects and ignores late responses', async (t) => {
  const scenario = await createRefreshScenario(t);
  scenario.render().selectPullRequestCommit(firstCommit);
  scenario.render();
  scenario.flushEffects();
  scenario.render().selectPullRequestCommit(secondCommit);
  requestAt(scenario.diffs, 0).resolve(diffResult(twoFilePatch));
  await settleRequests();
  assert.equal(scenario.render().pullRequestDiff, null);
  assert.equal(scenario.render().pullRequestDiffFiles.length, 0);
  assert.equal(scenario.render().pullRequestDiffLoading, true);
  scenario.flushEffects();
  requestAt(scenario.diffs, 1).resolve(diffResult('', secondCommit.oid));
  await settleRequests();
  assert.equal(scenario.render().pullRequestDiff?.headRefOid, secondCommit.oid);
  assert.equal(scenario.render().pullRequestDiffFiles.length, 0);
  assert.equal(scenario.render().pullRequestDiffLoading, false);
});

test('tabs, selecting the same commit, and list refresh reuse the selected commit diff', async (t) => {
  const scenario = await createRefreshScenario(t, diffResult(twoFilePatch));
  scenario.render().setSelectedPullRequestDiffPath('second.ts');
  scenario.render().setPullRequestDetailTab('commits');
  scenario.render().selectPullRequestCommit(firstCommit);
  const refresh = scenario.render().refreshPullRequests();
  assert.equal(scenario.render().pullRequestDiffLoading, false);
  requestAt(scenario.lists, 1).resolve(scenario.listResult);
  await refresh;
  scenario.render();
  scenario.flushEffects();
  assert.equal(scenario.diffs.length, 1);
  assert.equal(scenario.render().pullRequestDiffFiles.length, 2);
  assert.equal(scenario.render().selectedPullRequestDiffPath, 'second.ts');
});

test('a failed commit diff finishes loading and selecting it again retries', async (t) => {
  const scenario = await createRefreshScenario(t);
  scenario.render().selectPullRequestCommit(firstCommit);
  scenario.render();
  scenario.flushEffects();
  requestAt(scenario.diffs, 0).reject(new Error('Diff could not be fetched.'));
  await settleRequests();
  assert.equal(scenario.render().pullRequestDiffLoading, false);
  assert.equal(scenario.render().pullRequestDiffError, 'Diff could not be fetched.');
  scenario.render().selectPullRequestCommit(firstCommit);
  assert.equal(scenario.render().pullRequestDiffLoading, true);
  assert.equal(scenario.render().pullRequestDiffError, null);
  scenario.flushEffects();
  requestAt(scenario.diffs, 1).resolve(diffResult(twoFilePatch));
  await settleRequests();
  assert.equal(scenario.render().pullRequestDiffFiles.length, 2);
});

test('switching pull requests clears the commit selection without fetching another diff', async (t) => {
  const scenario = await createRefreshScenario(t, diffResult(twoFilePatch));
  scenario.render().selectPullRequest({ ...selectedPullRequest, number: 13 });
  const controller = scenario.render();
  assert.equal(controller.pullRequestDiffLoading, false);
  assert.equal(controller.selectedPullRequestCommit, null);
  assert.equal(controller.pullRequestDiff, null);
  assert.equal(controller.pullRequestDiffFiles.length, 0);
  assert.equal(controller.selectedPullRequestDiffPath, null);
  scenario.flushEffects();
  assert.equal(scenario.diffs.length, 1);
  scenario.render().selectPullRequest(selectedPullRequest);
  scenario.render();
  scenario.flushEffects();
  assert.equal(scenario.render().selectedPullRequestCommit, null);
});
