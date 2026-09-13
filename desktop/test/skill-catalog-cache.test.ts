import { expect, test } from 'bun:test';
import { createSkillCatalogCache } from '../frontend/src/features/chat/skillCatalogCache';

test('caches empty results, deduplicates requests and reloads only after invalidation', async () => {
  let calls = 0;
  let revision = 0;
  const cache = createSkillCatalogCache(async () => { calls++; return []; }, () => revision);
  expect(cache.peek()).toBeUndefined();
  await Promise.all([cache.read(), cache.read()]);
  expect(calls).toBe(1);
  expect(cache.peek()).toEqual([]);
  await cache.read();
  expect(calls).toBe(1);
  revision++;
  expect(cache.peek()).toBeUndefined();
  await cache.read();
  expect(calls).toBe(2);
});

test('failed requests can be retried and caches are isolated', async () => {
  let calls = 0;
  const cache = createSkillCatalogCache(async () => {
    if (++calls === 1) throw new Error('unavailable');
    return [];
  });
  const result = await cache.read().then(() => null, (error: Error) => error.message);
  expect(result).toBe('unavailable');
  expect(cache.peek()).toBeUndefined();
  expect(await cache.read()).toEqual([]);
  expect(calls).toBe(2);
  expect(createSkillCatalogCache(async () => []).peek()).toBeUndefined();
});

test('invalidation during a request discards the old result', async () => {
  let revision = 0;
  let calls = 0;
  const cache = createSkillCatalogCache(async () => {
    calls++;
    if (calls === 1) revision++;
    return [];
  }, () => revision);
  expect(await cache.read()).toEqual([]);
  expect(calls).toBe(2);
  expect(cache.peek()).toEqual([]);
});
