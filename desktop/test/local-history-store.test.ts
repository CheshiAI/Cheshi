import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalHistoryStore } from '../lib/local-history-store.mts';
import type { LocalHistoryCapture } from '../lib/local-history-store.mts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-history-store-'));
  directories.push(directory);
  return directory;
}

function capture(content: string, filePath = 'draft.txt'): LocalHistoryCapture {
  return { path: filePath, content, hasBom: false, lineEnding: 'lf', reason: 'saved' };
}

async function expectFailure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

describe('local history storage', () => {
  test('prunes expired records and blobs on reads, including after a restart', async () => {
    const directory = await fixture();
    let now = 1000;
    const store = new LocalHistoryStore({ directory, now: () => now, retentionMs: 100 });
    const oldest = await store.capture(capture('old'));
    now = 1050;
    const latest = await store.capture(capture('latest'));
    now = 1101;
    const reopened = new LocalHistoryStore({ directory, now: () => now, retentionMs: 100 });
    expect((await reopened.list('draft.txt')).map((entry) => entry.id)).toEqual([latest.id]);
    expect((await readdir(directory)).filter((name) => name.endsWith('.txt')).length).toBe(1);
    await expectFailure(reopened.read('draft.txt', oldest.id), /no longer available/);
    now = 1151;
    expect(await reopened.list('draft.txt')).toEqual([]);
    expect((await readdir(directory)).filter((name) => !name.startsWith('.writer-lock.sqlite'))).toEqual(['history.json']);
  });

  test('bounds metadata and unique content bytes and prunes the oldest versions first', async () => {
    const directory = await fixture();
    let now = 0;
    const store = new LocalHistoryStore({ directory, now: () => ++now, maxBytes: 1200 });
    const first = await store.capture(capture('a'.repeat(200)));
    const second = await store.capture(capture('b'.repeat(200)));
    const third = await store.capture(capture('c'.repeat(200)));
    const entries = await store.list('draft.txt');
    expect(entries.map((entry) => entry.id)).toEqual([third.id, second.id]);
    expect(entries.some((entry) => entry.id === first.id)).toBe(false);
    const sizes = await Promise.all((await readdir(directory)).map(async (name) => (await stat(path.join(directory, name))).size));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1200);
  });

  test('shares blobs across files and non-adjacent revisions, retaining the revision timeline', async () => {
    const directory = await fixture();
    const store = new LocalHistoryStore({ directory });
    const first = await store.capture(capture('a'));
    await store.capture(capture('b'));
    const again = await store.capture(capture('a'));
    await store.capture(capture('a', 'other.txt'));
    expect(first.id).not.toBe(again.id);
    expect((await store.list('draft.txt')).length).toBe(3);
    expect((await readdir(directory)).filter((name) => name.endsWith('.txt')).length).toBe(2);
    expect((await store.capture(capture('a'))).id).toBe(again.id);
    expect((await store.list('draft.txt')).length).toBe(3);
  });

  test('uses entry count limits for tiny-file histories and preserves remaining shared blobs', async () => {
    const directory = await fixture();
    const store = new LocalHistoryStore({ directory, maxEntries: 2 });
    await store.capture(capture('', 'one.txt'));
    await store.capture(capture('', 'two.txt'));
    await store.capture(capture('', 'three.txt'));
    expect(await store.list('one.txt')).toEqual([]);
    expect(await store.trackedPaths()).toEqual(['two.txt', 'three.txt']);
    expect((await readdir(directory)).filter((name) => name.endsWith('.txt')).length).toBe(1);
  });

  test('renews a duplicate predecessor without another record so quota and age pruning preserve undo', async () => {
    const directory = await fixture();
    let now = 1000;
    const store = new LocalHistoryStore({ directory, now: () => now, retentionMs: 100, maxEntries: 2 });
    const current = await store.capture(capture('current'));
    now = 1050;
    await store.capture(capture('other', 'other.txt'));
    now = 1099;
    const renewed = await store.capture({ ...capture('current'), reason: 'before-restore' });
    expect(renewed.id).toBe(current.id);
    expect(renewed.createdAt).toBe(1099);
    expect((await store.list('draft.txt')).length).toBe(1);
    now = 1101;
    await store.ensureCaptureFits(capture('restored'), [renewed.id]);
    await store.capture({ ...capture('restored'), reason: 'restored' }, [renewed.id]);
    expect((await store.list('draft.txt')).map((entry) => entry.reason)).toEqual(['restored', 'before-restore']);
    expect((await store.read('draft.txt', renewed.id)).content).toBe('current');
    expect(await store.list('other.txt')).toEqual([]);
  });

  test('retains exact UTF-8 content, BOM and all line-ending metadata through persistence', async () => {
    const directory = await fixture();
    const store = new LocalHistoryStore({ directory });
    const content = '한글\r\nsecond\rthird\n';
    const entry = await store.capture({ ...capture(content), hasBom: true, lineEnding: 'crlf' });
    const reopened = new LocalHistoryStore({ directory });
    const snapshot = await reopened.read('draft.txt', entry.id);
    expect(snapshot.content).toBe(content);
    expect(snapshot.hasBom).toBe(true);
    expect(snapshot.lineEnding).toBe('crlf');
    expect(snapshot.entry.size).toBe(Buffer.byteLength(`\uFEFF${content}`));
  });

  test('cleans interrupted orphan writes without deleting unrelated files', async () => {
    const directory = await fixture();
    const store = new LocalHistoryStore({ directory });
    await store.capture(capture('kept'));
    await writeFile(path.join(directory, `${'0'.repeat(64)}.txt`), 'orphan');
    await writeFile(path.join(directory, 'history.json.12345678-1234-1234-1234-123456789012.tmp'), 'unfinished');
    await writeFile(path.join(directory, 'unrelated.txt'), 'leave alone');
    const reopened = new LocalHistoryStore({ directory });
    expect((await reopened.list('draft.txt')).length).toBe(1);
    const files = await readdir(directory);
    expect(files.filter((name) => !name.startsWith('.writer-lock.sqlite')).length).toBe(3);
    expect(files.includes('unrelated.txt')).toBe(true);
  });

  test('refuses damaged blobs and repairs duplicate content before marking it protected', async () => {
    const directory = await fixture();
    const store = new LocalHistoryStore({ directory });
    const entry = await store.capture(capture('original'));
    const blob = (await readdir(directory)).find((name) => name.endsWith('.txt'))!;
    await writeFile(path.join(directory, blob), 'corrupted');
    await expectFailure(store.read('draft.txt', entry.id), /damaged/);
    expect((await store.capture(capture('original'))).id).toBe(entry.id);
    expect((await store.read('draft.txt', entry.id)).content).toBe('original');
    await unlink(path.join(directory, blob));
    await store.capture(capture('original'));
    expect((await store.read('draft.txt', entry.id)).content).toBe('original');
  });

  test('preserves a malformed manifest and refuses to silently reset history', async () => {
    const directory = await fixture();
    const manifestPath = path.join(directory, 'history.json');
    await writeFile(manifestPath, '{"version":2,"entries":[]}');
    const store = new LocalHistoryStore({ directory });
    await expectFailure(store.capture(capture('new')), /metadata is invalid/);
    expect(await readFile(manifestPath, 'utf8')).toBe('{"version":2,"entries":[]}');
  });
});
