import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatHistorySearch } from '../lib/chat-history-search.mts';
import { openSearchDatabase, type SearchDatabase } from '../lib/chat-search-database.mts';
import { ChatSearchIndex } from '../lib/chat-search-index.mts';
import { ChatSearchQuery } from '../lib/chat-search-query.mts';
import { compileSearchRecord, searchSessions } from '../lib/chat-search-source.mts';
import { chatHistorySearchRequest } from '../shared/chat-history-search.ts';

const cwd = '/workspace/project';
const directories: string[] = [];
const services: ChatHistorySearch[] = [];
const databases: SearchDatabase[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'cheshi-search-index-'));
  directories.push(path); return path;
}
function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function raw(text: string) {
  return { thread: { id: 'one', cwd, turns: [{ id: 'turn', items: [{ id: 'item', type: 'agentMessage', text }] }] } };
}
async function fixture() {
  const path = await directory();
  let text = '수정 needle';
  let revision = 1;
  let reads = 0;
  let block: (() => Promise<void>) | null = null;
  let catalogFailed = false;
  const historyPath = join(path, 'rollout.jsonl');
  await writeFile(historyPath, 'one');
  const source = {
    async list() {
      if (catalogFailed) throw new Error('Catalog unavailable');
      return { sessions: [{ id: 'one', title: 'One', updatedAt: revision, historyPath }] };
    },
    async read() { reads++; await block?.(); return raw(text); },
  };
  const options = { directory: path, cwd, source };
  const search = new ChatHistorySearch(options); services.push(search);
  return { search, options, path, historyPath, reads: () => reads,
    text: (value: string) => { text = value; }, revision: () => { revision++; },
    block: (value: (() => Promise<void>) | null) => { block = value; },
    failCatalog: () => { catalogFailed = true; } };
}

test('short Unicode substrings, normalization and punctuation keep exact semantics after gram candidate filtering', async () => {
  const path = await directory();
  const db = await openSearchDatabase(join(path, 'search.sqlite'), cwd); databases.push(db);
  const index = new ChatSearchIndex(db);
  const query = new ChatSearchQuery(db);
  const session = searchSessions({ sessions: [{ id: 'one', title: 'One', updatedAt: 1 }] })[0]!;
  index.put(compileSearchRecord(raw('수정 한글 😀🙂É abc---bcd "OR"'), cwd, session, 1), null);
  for (const text of ['수', '수정', '한글', '😀', '😀🙂', 'é', '"or"', 'abc bcd']) {
    expect(query.search(chatHistorySearchRequest({ query: text }), 1).total).toBe(1);
  }
  expect(query.search(chatHistorySearchRequest({ query: 'abcd' }), 1).total).toBe(0);
  expect(query.search(chatHistorySearchRequest({ query: "' OR 1=1 --" }), 1).total).toBe(0);
});

test('unchanged entry hashes preserve row ids while changed and removed entries update atomically', async () => {
  const path = await directory();
  const db = await openSearchDatabase(join(path, 'search.sqlite'), cwd); databases.push(db);
  const index = new ChatSearchIndex(db);
  const query = new ChatSearchQuery(db);
  const session = searchSessions({ sessions: [{ id: 'one', title: 'One', updatedAt: 1 }] })[0]!;
  const record = compileSearchRecord(raw('original'), cwd, session, 1);
  index.put(record, 'before');
  const id = db.prepare('SELECT id FROM entries').get();
  index.put({ ...record, checkedAt: 2 }, 'after');
  expect(db.prepare('SELECT id FROM entries').get()).toEqual(id);
  index.put(compileSearchRecord(raw('updated'), cwd, session, 3), 'third');
  expect(db.prepare('SELECT id FROM entries').get()).not.toEqual(id);
  expect(query.search(chatHistorySearchRequest({ query: 'original' }), 3).total).toBe(0);
  expect(query.search(chatHistorySearchRequest({ query: 'updated' }), 3).total).toBe(1);
  index.remove([session.sourceKey]);
  expect(query.search(chatHistorySearchRequest({ query: 'updated' }), 3).total).toBe(0);
  expect(db.prepare('SELECT count(*) AS count FROM grams').get()).toEqual({ count: 0 });
});

test('file fingerprints detect edits without metadata changes and unchanged histories are not reread', async () => {
  const f = await fixture();
  await f.search.search({ query: '수정' });
  await f.search.synchronize();
  expect(f.reads()).toBe(1);
  f.text('새 내용');
  await writeFile(f.historyPath, 'changed content');
  await f.search.synchronize();
  expect(f.reads()).toBe(2);
  expect((await f.search.search({ query: '새 내용' })).total).toBe(1);
  await rm(f.historyPath);
  await f.search.synchronize();
  expect((await f.search.search({ query: '새 내용' })).unavailableSessions).toEqual(['one']);
  expect((await f.search.search({ query: '새 내용' })).total).toBe(0);
});

test('WAL readers keep the committed result during an uncommitted writer transaction', async () => {
  const path = await directory();
  const filename = join(path, 'search.sqlite');
  const writer = await openSearchDatabase(filename, cwd); databases.push(writer);
  const session = searchSessions({ sessions: [{ id: 'one', title: 'One', updatedAt: 1 }] })[0]!;
  new ChatSearchIndex(writer).put(compileSearchRecord(raw('committed'), cwd, session, 1), null);
  const reader = await openSearchDatabase(filename, cwd, true); databases.push(reader);
  writer.exec("BEGIN IMMEDIATE; UPDATE entries SET text='uncommitted';");
  try {
    expect(new ChatSearchQuery(reader).search(chatHistorySearchRequest({ query: 'committed' }), 1).hits[0]?.snippet).toBe('committed');
  } finally { writer.exec('ROLLBACK'); }
});

test('a fingerprint-only update preserves pagination while a content change expires it', async () => {
  const path = await directory();
  const db = await openSearchDatabase(join(path, 'search.sqlite'), cwd); databases.push(db);
  const index = new ChatSearchIndex(db); const query = new ChatSearchQuery(db);
  const session = searchSessions({ sessions: [{ id: 'one', title: 'One', updatedAt: 1 }] })[0]!;
  const record = compileSearchRecord(raw('needle'), cwd, session, 1);
  record.thread.entries.push({ ...record.thread.entries[0]!, itemId: 'second' });
  index.put(record, 'before');
  const request = chatHistorySearchRequest({ query: 'needle', limit: 1 });
  const first = query.search(request, 1);
  index.put({ ...record, checkedAt: 2 }, 'after');
  expect(query.search({ ...request, cursor: first.nextCursor }, 2).hits[0]?.itemId).toBe('second');
  record.thread.entries.pop();
  index.put(record, 'third');
  expect(() => query.search({ ...request, cursor: first.nextCursor }, 3)).toThrow(/expired or changed/);
});

test('indexed queries remain available while a background history read is blocked', async () => {
  const f = await fixture();
  await f.search.search({ query: '수정' });
  const entered = createDeferred(); const release = createDeferred();
  f.revision(); f.text('updated');
  f.block(async () => { entered.resolve(); await release.promise; });
  const syncing = f.search.synchronize();
  await entered.promise;
  try {
    const result = await f.search.search({ query: '수정' });
    expect(result.total).toBe(1);
    expect(result.indexState).toBe('updating');
  } finally { release.resolve(); await syncing; }
  expect((await f.search.search({ query: 'updated' })).total).toBe(1);
});

test('a failed background catalog check exposes stale status without making the persistent index unusable', async () => {
  const f = await fixture();
  await f.search.search({ query: '수정' });
  f.failCatalog();
  let failure: unknown;
  try { await f.search.synchronize(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const result = await f.search.search({ query: '수정' });
  expect(result.total).toBe(1);
  expect(result.indexState).toBe('error');
});

test('native Node loads the worker and persistent SQLite index without a TypeScript transform', async () => {
  const path = await directory();
  const module = pathToFileURL(join(import.meta.dir, '../lib/chat-history-search.mts')).href;
  const code = `import { ChatHistorySearch } from ${JSON.stringify(module)};
    const service = new ChatHistorySearch({ directory: ${JSON.stringify(path)}, cwd: ${JSON.stringify(cwd)},
      source: { list: async () => ({sessions:[{id:'one',title:'One',updatedAt:1}]}), read: async () => (${JSON.stringify(raw('수정'))}) } });
    try { const result = await service.search({query:'수정'}); if(result.total!==1) throw Error('Missing native result'); }
    finally { await service.stop(); }`;
  const child = Bun.spawn(['node', '--input-type=module', '-e', code], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
});
