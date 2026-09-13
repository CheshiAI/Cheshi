import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isPromise } from 'node:util/types';
import vm from 'node:vm';

type GitMethod = 'prepareGitDiscard' | 'discardGitChanges' | 'getGitBranchCommits' | 'getGitHubPullRequestDiff';

function createPreloadHarness(invoke: (channel: string, request: unknown, ...additionalArgs: unknown[]) => Promise<unknown>) {
  const exposed = new Map<string, Record<string, unknown>>();
  const calls: { channel: string; request: unknown; additionalArgs?: unknown[] }[] = [];
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform },
    window: { addEventListener() {} },
    document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(key: string, value: unknown) {
            assert.ok(typeof value === 'object' && value !== null);
            exposed.set(key, value as Record<string, unknown>);
          },
        },
        ipcRenderer: {
          sendSync(channel: string) {
            assert.equal(channel, 'cheshi:get-workspace-metadata');
            return { workspaceName: 'test', workspaceRoot: '/tmp/test' };
          },
          invoke(channel: string, request: unknown, ...additionalArgs: unknown[]) {
            calls.push({ channel, request: structuredClone(request),
              ...(additionalArgs.length > 0 ? { additionalArgs: structuredClone(additionalArgs) } : {}),
            });
            return invoke(channel, request, ...additionalArgs);
          },
        },
      };
    },
  });
  return {
    calls,
    call(method: GitMethod, request: unknown, ...additionalArgs: unknown[]): unknown {
      const operation = exposed.get('cheshiDesktop')?.[method];
      assert.equal(typeof operation, 'function');
      assert.ok(typeof operation === 'function');
      return operation(request, ...additionalArgs);
    },
  };
}

function callPreload(
  preload: ReturnType<typeof createPreloadHarness>, method: GitMethod, request: unknown,
  ...additionalArgs: unknown[]
): Promise<unknown> {
  let operation: unknown;
  assert.doesNotThrow(() => { operation = preload.call(method, request, ...additionalArgs); });
  assert.ok(isPromise(operation));
  return operation;
}

test('prepares selected files through the built preload without invoking discard', async () => {
  const preview = { files: [], revision: 'a'.repeat(64) };
  const preload = createPreloadHarness(async () => preview);
  const targets = [
    { path: 'alpha.txt', scope: 'working' },
    { path: 'alpha.txt', scope: 'staged' },
    { path: ' spaced name .txt ', scope: 'working' },
  ];
  assert.equal(await callPreload(preload, 'prepareGitDiscard', { targets }), preview);
  assert.deepEqual(preload.calls, [{
    channel: 'cheshi:prepare-git-discard',
    request: { targets: [targets[1], targets[2]] },
  }]);
});

test('routes local and remote history reads through the preload without requesting checkout', async () => {
  const preload = createPreloadHarness(async () => []);
  const references = ['refs/heads/main', 'refs/remotes/origin/main'];
  for (const reference of references) {
    await callPreload(preload, 'getGitBranchCommits', reference);
  }
  assert.deepEqual(preload.calls, references.map((reference) => ({
    channel: 'cheshi:get-git-branch-commits', request: reference,
  })));
});

test('rejects invalid history references before sending an IPC request', async () => {
  const preload = createPreloadHarness(async () => []);
  for (const reference of [null, {}, '', '--all', 'main', 'refs/tags/release']) {
    await assert.rejects(callPreload(preload, 'getGitBranchCommits', reference), /Git branch/u);
  }
  assert.deepEqual(preload.calls, []);
});

test('passes the selected PR commit through the built preload and rejects invalid object IDs', async () => {
  const preload = createPreloadHarness(async () => null);
  const oid = 'a'.repeat(40);
  await callPreload(preload, 'getGitHubPullRequestDiff', 12, oid);
  assert.deepEqual(preload.calls, [{
    channel: 'cheshi:get-github-pull-request-diff', request: 12, additionalArgs: [oid],
  }]);
  for (const invalid of [null, 12, '', 'HEAD', `${oid}^`]) {
    await assert.rejects(callPreload(preload, 'getGitHubPullRequestDiff', 12, invalid), /commit/u);
  }
  assert.equal(preload.calls.length, 1);
});

test('returns rejected promises for invalid preview requests so the dialog can display errors', async () => {
  const preload = createPreloadHarness(async () => null);
  const requests = [
    { targets: [] },
    { targets: [{ path: '../outside.txt', scope: 'working' }] },
    { targets: Array.from({ length: 1_001 }, (_, index) => ({ path: `${index}.txt`, scope: 'working' })) },
  ];
  for (const request of requests) {
    await assert.rejects(callPreload(preload, 'prepareGitDiscard', request), /Select|workspace/u);
  }
  assert.deepEqual(preload.calls, []);
});

test('requires literal confirmation before the built preload sends a discard request', async () => {
  const preload = createPreloadHarness(async () => null);
  const targets = [{ path: 'alpha.txt', scope: 'working' }];
  for (const confirmed of [undefined, false, 'true', 1]) {
    await assert.rejects(callPreload(preload, 'discardGitChanges', {
      targets, expectedRevision: 'a'.repeat(64), confirmed,
    }), /Confirm/u);
  }
  assert.deepEqual(preload.calls, []);
});

test('sends only the confirmed file selection and revision through the built preload', async () => {
  const snapshot = { available: true, changes: [] };
  const preload = createPreloadHarness(async () => snapshot);
  const request = {
    targets: [{ path: 'alpha.txt', scope: 'working' }],
    confirmed: true,
    expectedRevision: 'a'.repeat(64),
  };
  assert.equal(await callPreload(preload, 'discardGitChanges', request), snapshot);
  assert.deepEqual(preload.calls, [{ channel: 'cheshi:discard-git-changes', request }]);
});

test('applies the selection limit to unique files instead of working and staged rows', async () => {
  const preload = createPreloadHarness(async () => null);
  const files = Array.from({ length: 1_000 }, (_, index) => `${index}.txt`);
  const targets = files.flatMap((filePath) => [
    { path: filePath, scope: 'working' },
    { path: filePath, scope: 'staged' },
  ]);
  await callPreload(preload, 'prepareGitDiscard', { targets });
  assert.deepEqual(preload.calls, [{
    channel: 'cheshi:prepare-git-discard',
    request: { targets: files.map((filePath) => ({ path: filePath, scope: 'staged' })) },
  }]);
  await assert.rejects(callPreload(preload, 'prepareGitDiscard', {
    targets: [...targets, { path: 'extra.txt', scope: 'working' }],
  }), /Select/u);
  assert.equal(preload.calls.length, 1);
});
