import { expect, test } from 'bun:test';
import { AppleNotesCache } from '../lib/apple-notes-cache.mts';
import type { AppleNotesReply } from '../shared/apple-notes.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const success = <T>(value: T): AppleNotesReply<T> => ({ ok: true, value });

test('coalesces concurrent reads, isolates returned values, and expires on the next request', async () => {
  let now = 0;
  let calls = 0;
  const cache = new AppleNotesCache({ now: () => now });
  const pending = createDeferred<AppleNotesReply<{ title: string }>>();
  const load = () => { calls += 1; return pending.promise; };
  const first = cache.read('note', load);
  const second = cache.read('note', load);
  await Promise.resolve();
  expect(calls).toBe(1);
  pending.resolve(success({ title: 'Original' }));
  const result = await first;
  if (result.ok) result.value.title = 'Caller edit';
  expect(await second).toEqual(success({ title: 'Original' }));
  now = 29_999;
  expect(await cache.read('note', load)).toEqual(success({ title: 'Original' }));
  expect(calls).toBe(1);
  now = 30_000;
  expect(calls).toBe(1);
  await cache.read('note', load);
  expect(calls).toBe(2);
});

test('invalidation prevents an old request from repopulating or removing a newer pending request', async () => {
  const cache = new AppleNotesCache();
  const old = createDeferred<AppleNotesReply<string>>();
  const current = createDeferred<AppleNotesReply<string>>();
  const first = cache.read('note', () => old.promise);
  cache.invalidate();
  let currentCalls = 0;
  const loadCurrent = () => { currentCalls += 1; return current.promise; };
  const second = cache.read('note', loadCurrent);
  old.resolve(success('old'));
  expect(await first).toEqual(success('old'));
  const third = cache.read('note', loadCurrent);
  current.resolve(success('new'));
  expect(await second).toEqual(success('new'));
  expect(await third).toEqual(success('new'));
  expect(currentCalls).toBe(1);
  expect(await cache.read('note', async () => success('unexpected'))).toEqual(success('new'));
});

test('errors are not retained and large entries do not evict useful cached data', async () => {
  const cache = new AppleNotesCache({ maxBytes: 150 });
  let calls = 0;
  const fail = async (): Promise<AppleNotesReply<string>> => { calls += 1; return { ok: false, error: { code: 'permission', message: 'Denied' } }; };
  await cache.read('error', fail);
  await cache.read('error', fail);
  expect(calls).toBe(2);
  await cache.read('small', async () => success('small'));
  let largeCalls = 0;
  const large = async () => { largeCalls += 1; return success('x'.repeat(200)); };
  await cache.read('large', large);
  await cache.read('large', large);
  expect(largeCalls).toBe(2);
  expect(await cache.read('small', async () => success('unexpected'))).toEqual(success('small'));
});

test('entry and byte limits evict least recently used results', async () => {
  for (const options of [{ maxEntries: 2 }, { maxBytes: 110 }]) {
    const cache = new AppleNotesCache(options);
    const counts = new Map<string, number>();
    const read = (key: string) => cache.read(key, async () => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return success(key.repeat(20));
    });
    await read('a'); await read('b'); await read('a'); await read('c'); await read('a'); await read('b');
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(2);
  }
});

test('selective invalidation preserves other results and pending loads while discarding stale target loads', async () => {
  const cache = new AppleNotesCache();
  await cache.read('folders', async () => success('folders'));
  const removed = createDeferred<AppleNotesReply<string>>();
  const retained = createDeferred<AppleNotesReply<string>>();
  const oldRead = cache.read('deleted-note', () => removed.promise);
  const otherRead = cache.read('other-note', () => retained.promise);
  cache.invalidate(key => key === 'deleted-note');
  removed.resolve(success('old'));
  retained.resolve(success('retained'));
  await Promise.all([oldRead, otherRead]);
  expect(await cache.read('deleted-note', async () => success('fresh'))).toEqual(success('fresh'));
  expect(await cache.read('other-note', async () => success('unexpected'))).toEqual(success('retained'));
  expect(await cache.read('folders', async () => success('unexpected'))).toEqual(success('folders'));
});
