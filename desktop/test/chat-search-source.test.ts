import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyFingerprint, searchSessions } from '../lib/chat-search-source.mts';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { account, flashFixture, history, rejection, session } from './flash-test-helpers.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-history-fingerprint-'));
  directories.push(directory);
  const historyPath = join(directory, 'rollout.jsonl');
  const catalog = { ...session(), historyPath };
  const source = searchSessions({ sessions: [catalog] })[0]!;
  return { directory, historyPath, compressed: `${historyPath}.zst`, catalog, source };
}

test('fingerprints support compressed histories and track their actual storage path', async () => {
  const f = await fixture();
  await writeFile(f.compressed, 'compressed history');
  const compressed = await historyFingerprint(f.source);
  expect(JSON.parse(compressed!)[0]).toBe(f.compressed);
  expect(await historyFingerprint({ ...f.source, historyPath: f.compressed })).toBe(compressed);
  expect(await historyFingerprint(f.source)).toBe(compressed);
  await writeFile(f.compressed, 'updated compressed history');
  expect(await historyFingerprint(f.source)).not.toBe(compressed);
});

test('plain histories take precedence and compression transitions invalidate cached fingerprints', async () => {
  const f = await fixture();
  await writeFile(f.historyPath, 'plain history');
  const plain = await historyFingerprint(f.source);
  await rename(f.historyPath, f.compressed);
  const compressed = await historyFingerprint(f.source);
  expect(compressed).not.toBe(plain);
  await rename(f.compressed, f.historyPath);
  expect(JSON.parse((await historyFingerprint(f.source))!)[0]).toBe(f.historyPath);
  await writeFile(f.compressed, 'other compressed data');
  const restored = await historyFingerprint(f.source);
  await writeFile(f.compressed, 'changed compressed data');
  expect(await historyFingerprint(f.source)).toBe(restored);
});

test('absent histories and filesystem errors remain failures rather than trusted cached data', async () => {
  const f = await fixture();
  expect(await historyFingerprint({ ...f.source, historyPath: undefined })).toBeNull();
  expect(await rejection(() => historyFingerprint(f.source))).toHaveProperty('code', 'ENOENT');
  const parent = join(f.directory, 'not-a-directory');
  await writeFile(parent, 'file');
  expect(await rejection(() => historyFingerprint({ ...f.source, historyPath: join(parent, 'rollout.jsonl') })))
    .toHaveProperty('code', 'ENOTDIR');
});

test('Flash synchronizes and searches a compressed history through the original conversation API', async () => {
  const f = await fixture();
  const flash = await flashFixture();
  // Fingerprinting reads metadata only; the conversation API owns decompression.
  await writeFile(f.compressed, 'compressed bytes');
  let text = 'Saved decision';
  let reads = 0;
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: flash.host,
    source: { list: async () => ({ sessions: [f.catalog] }), read: async () => { reads++; return history(text); } } });
  memory.accounts(account());
  try {
    await memory.synchronize();
    expect(memory.status()).toMatchObject({ state: 'ready', processed: 1, total: 1 });
    await memory.synchronize();
    expect(reads).toBe(1);
    text = 'Updated decision';
    await writeFile(f.compressed, 'updated compressed bytes');
    await memory.synchronize();
    expect(reads).toBe(2);
    const result = await memory.execute('memory_search', { query: 'decision' }, 'caller', new AbortController().signal);
    expect(result).toMatchObject({ matches: [{ text: 'Updated decision' }] });
    expect(flash.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
  } finally { await memory.dispose(); await flash.close(); }
});
