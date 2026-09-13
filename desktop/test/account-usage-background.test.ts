import { expect, test } from 'bun:test';
import { createAccountUsageBackground } from '../lib/account-usage-background.mts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';

type Options = Parameters<typeof createAccountUsageBackground>[0];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Background usage update did not complete');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function harness(intervalMs?: number) {
  const initial: CodexAccountsSnapshot = { activeId: 'initial', profiles: [] };
  const updates: CodexAccountsSnapshot[] = [];
  const errors: unknown[] = [];
  const listeners = new Set<(snapshot: CodexAccountsSnapshot) => void>();
  let acquisitions = 0;
  let listings = 0;
  let releases = 0;
  let acquireFailure: Error | null = null;
  let list: ReturnType<Options['acquire']>['list'] = async () => initial;
  const service = createAccountUsageBackground({
    intervalMs,
    acquire() {
      acquisitions++;
      if (acquireFailure) throw acquireFailure;
      return {
        async list() { listings++; return await list(); },
        onDidChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async release() { releases++; },
      };
    },
    update(snapshot) { updates.push(snapshot); },
    onError(error) { errors.push(error); },
  });
  return {
    service, initial, updates, errors, listeners,
    setList(operation: typeof list) { list = operation; },
    failAcquire(error: Error | null) { acquireFailure = error; },
    get acquisitions() { return acquisitions; },
    get listings() { return listings; },
    get releases() { return releases; },
  };
}

test('starts lazily and retains one account source while forwarding initial and event updates', async () => {
  const app = harness();
  try {
    expect(app.acquisitions).toBe(0);
    app.service.start();
    app.service.start();
    await waitFor(() => app.updates.length === 1);
    expect(app.acquisitions).toBe(1);
    expect(app.listings).toBe(1);
    expect(app.listeners.size).toBe(1);
    expect(app.updates[0]).toEqual(app.initial);
    const changed: CodexAccountsSnapshot = { activeId: 'changed', profiles: [] };
    for (const listener of app.listeners) listener(changed);
    expect(app.updates.at(-1)).toEqual(changed);
    expect(app.releases).toBe(0);
  } finally { await app.service.dispose(); }
  expect(app.releases).toBe(1);
  expect(app.listeners.size).toBe(0);
});

test('refreshes on later intervals without overlapping an unfinished account request', async () => {
  const app = harness(10);
  const pending = createDeferred<CodexAccountsSnapshot>();
  const changed: CodexAccountsSnapshot = { activeId: 'polled', profiles: [] };
  app.setList(() => pending.promise);
  try {
    app.service.start();
    await waitFor(() => app.listings === 1);
    await new Promise(resolve => setTimeout(resolve, 45));
    expect(app.listings).toBe(1);
    expect(app.updates).toEqual([]);
    app.setList(async () => changed);
    pending.resolve(app.initial);
    await waitFor(() => app.updates.some(snapshot => snapshot.activeId === 'polled'));
    expect(app.updates[0]).toEqual(app.initial);
    expect(app.listings).toBeGreaterThanOrEqual(2);
    expect(app.acquisitions).toBe(1);
  } finally { pending.resolve(app.initial); await app.service.dispose(); }
});

test('reports a refresh failure and recovers on a later interval', async () => {
  const app = harness(10);
  const failure = new Error('Account service unavailable');
  let attempt = 0;
  app.setList(async () => {
    if (attempt++ === 0) throw failure;
    return app.initial;
  });
  try {
    app.service.start();
    await waitFor(() => app.updates.length > 0);
    expect(app.errors).toEqual([failure]);
    expect(app.updates[0]).toEqual(app.initial);
    expect(app.acquisitions).toBe(1);
  } finally { await app.service.dispose(); }
});

test('disposal stops polling and ignores queued events and late request completion', async () => {
  const app = harness(10);
  const pending = createDeferred<CodexAccountsSnapshot>();
  app.setList(() => pending.promise);
  app.service.start();
  await waitFor(() => app.listings === 1);
  const queuedListener = [...app.listeners][0]!;
  const disposal = app.service.dispose();
  queuedListener(app.initial);
  pending.resolve(app.initial);
  await disposal;
  await app.service.dispose();
  app.service.start();
  await new Promise(resolve => setTimeout(resolve, 35));
  expect(app.updates).toEqual([]);
  expect(app.errors).toEqual([]);
  expect(app.listeners.size).toBe(0);
  expect(app.listings).toBe(1);
  expect(app.acquisitions).toBe(1);
  expect(app.releases).toBe(1);
});

test('a failed acquisition can be retried by a later start without leaking a source', async () => {
  const app = harness();
  const failure = new Error('Account registry is not ready');
  app.failAcquire(failure);
  try {
    app.service.start();
    expect(app.errors).toEqual([failure]);
    expect(app.listeners.size).toBe(0);
    expect(app.releases).toBe(0);
    app.failAcquire(null);
    app.service.start();
    await waitFor(() => app.updates.length === 1);
    expect(app.acquisitions).toBe(2);
    expect(app.listeners.size).toBe(1);
  } finally { await app.service.dispose(); }
  expect(app.releases).toBe(1);
});

test('disposal before startup does not acquire accounts or restart monitoring', async () => {
  const app = harness();
  await app.service.dispose();
  app.service.start();
  await app.service.dispose();
  expect(app.acquisitions).toBe(0);
  expect(app.listings).toBe(0);
  expect(app.releases).toBe(0);
});
