import { expect, test } from 'bun:test';

import { createPluginCatalogCache } from '../frontend/src/features/plugins/pluginCatalogCache';
import type { CodexPluginCatalog } from '../frontend/src/cheshiDesktop';

function catalog(marker: string): CodexPluginCatalog {
  return { plugins: [], featuredPluginIds: [marker], marketplaceErrors: [] };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function expectFailure(operation: Promise<unknown>) {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
}

test('reuses the catalog immediately on subsequent page visits without another request', async () => {
  let calls = 0;
  const value = catalog('first');
  const cache = createPluginCatalogCache(async () => { calls += 1; return value; });
  expect(cache.peek()).toBeNull();
  expect(await cache.load()).toBe(value);
  expect(cache.peek()).toBe(value);
  expect(await cache.load()).toBe(value);
  expect(calls).toBe(1);
});

test('shares a pending request when the page is reopened before loading finishes', async () => {
  const request = createDeferred<CodexPluginCatalog>();
  let calls = 0;
  const cache = createPluginCatalogCache(() => { calls += 1; return request.promise; });
  const first = cache.load();
  expect(cache.load()).toBe(first);
  request.resolve(catalog('loaded'));
  await first;
  expect(calls).toBe(1);
});

test('explicit refresh replaces the cache and preserves the previous list while loading', async () => {
  const previous = catalog('previous');
  const next = catalog('installed');
  const refresh = createDeferred<CodexPluginCatalog>();
  const calls: boolean[] = [];
  const cache = createPluginCatalogCache(async (force) => {
    calls.push(force);
    return force ? refresh.promise : previous;
  });
  await cache.load();
  const operation = cache.load(true);
  expect(cache.peek()).toBe(previous);
  expect(cache.load(true)).toBe(operation);
  refresh.resolve(next);
  expect(await operation).toBe(next);
  expect(await cache.load()).toBe(next);
  expect(calls).toEqual([false, true]);
});

test('a late initial request cannot overwrite a newer forced refresh', async () => {
  const initial = createDeferred<CodexPluginCatalog>();
  const next = catalog('newer');
  const cache = createPluginCatalogCache(async (force) => force ? next : initial.promise);
  const oldOperation = cache.load();
  expect(await cache.load(true)).toBe(next);
  initial.resolve(catalog('older'));
  await oldOperation;
  expect(cache.peek()).toBe(next);
});

test('retries failed initial loads and keeps successful data after a failed refresh', async () => {
  let fail = true;
  const value = catalog('loaded');
  const cache = createPluginCatalogCache(async () => {
    if (fail) throw new Error('Unavailable');
    return value;
  });
  await expectFailure(cache.load());
  expect(cache.peek()).toBeNull();
  fail = false;
  expect(await cache.load()).toBe(value);
  fail = true;
  await expectFailure(cache.load(true));
  expect(await cache.load()).toBe(value);
});
