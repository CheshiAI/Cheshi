import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatHistorySearch } from '../lib/chat-history-search.mts';
import { CHAT_HISTORY_INDEX_VERSION } from '../lib/chat-history-index-store.mts';
import { chatHistorySearchRequest, chatHistorySearchResponse } from '../shared/chat-history-search.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function failure(operation: () => unknown | Promise<unknown>, pattern: RegExp) {
  let reason: unknown;
  try { await operation(); } catch (error) { reason = error; }
  expect(reason).toBeInstanceOf(Error);
  expect((reason as Error).message).toMatch(pattern);
}

const cwd = '/workspace/project';
function thread(id: string, text: string, forkedFromId?: string) {
  return { id, cwd, forkedFromId, turns: [{ id: 'turn-one', status: 'completed', items: [
    { id: 'question', type: 'userMessage', content: [{ type: 'text', text }] },
    { id: 'answer', type: 'agentMessage', text: '확인했습니다.' },
  ] }] };
}
function changedFileThread(id: string, path: string, diff: string) {
  return { id, cwd, turns: [{ id: 'turn-one', status: 'completed', items: [
    { id: 'file-change', type: 'fileChange', status: 'completed', cwd: join(cwd, 'src'),
      changes: [{ path, kind: 'update', diff }] },
  ] }] };
}
type Thread = ReturnType<typeof thread> | ReturnType<typeof changedFileThread>;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-history-search-'));
  directories.push(directory);
  const threads = new Map<string, Thread>();
  const versions = new Map<string, number>();
  const active = new Set<string>();
  const failed = new Set<string>();
  const reads: string[] = [];
  const ownerReads: Array<[string, string | undefined]> = [];
  let now = 100_000;
  const source = {
    async list() { return { sessions: [...threads.keys()].map(id => ({ id, profileId: 'account', title: `Session ${id}`,
      updatedAt: versions.get(id) ?? 1, preview: '', status: active.has(id) ? 'active' : 'idle' })) }; },
    async read(id: string, profileId?: string) {
      reads.push(id);
      ownerReads.push([id, profileId]);
      if (failed.has(id)) throw new Error('Account unavailable.');
      return { thread: threads.get(id) };
    },
  };
  const options = { directory, cwd, source, now: () => now };
  return { directory, threads, versions, active, failed, reads, ownerReads, source, options,
    advance: (ms: number) => { now += ms; }, search: new ChatHistorySearch(options) };
}

test('indexes Korean source text with exact source ids and workspace file filtering', async () => {
  const f = await fixture();
  f.threads.set('one', thread('one', '검색 오류는 `src/검색.ts`에서 확인했습니다.'));
  f.threads.set('two', thread('two', '다른 파일 `src/other.ts`의 오류입니다.'));
  const result = await f.search.search({ query: '검색 오류', filePath: `${cwd}/src/검색.ts` });
  expect(result.total).toBe(1);
  expect(result.hits[0]).toMatchObject({ threadId: 'one', turnId: 'turn-one', itemId: 'question', kind: 'user', duplicateCount: 0 });
  expect(result.hits[0]?.files).toContainEqual({ path: 'src/검색.ts', kind: 'mentioned' });
  expect(result.indexedSessions).toBe(2);
  expect(f.ownerReads).toEqual([['one', 'account'], ['two', 'account']]);
  expect(chatHistorySearchResponse(result)).toEqual(result);
  expect((await f.search.search({ query: '', filePath: 'src/other.ts' })).hits[0]?.threadId).toBe('two');
  await failure(() => f.search.search({ query: '오류', filePath: '../outside.ts' }), /workspace/);
});

test('searches message text and normalized file references together with every query term required', async () => {
  const f = await fixture();
  f.threads.set('changed', changedFileThread('changed', '검색 파일.ts', '- 실패\n+ 검색 오류 복구'));
  f.threads.set('message', thread('message', '검색 오류를 설명합니다.'));

  const textOnly = await f.search.search({ query: '검색 오류' });
  expect(textOnly.hits.map(hit => hit.threadId).sort()).toEqual(['changed', 'message']);
  const mixed = await f.search.search({ query: '복구 src/검색 파일.ts' });
  expect(mixed.total).toBe(1);
  expect(mixed.hits[0]).toMatchObject({ threadId: 'changed', itemId: 'file-change', kind: 'activity' });
  expect(mixed.hits[0]?.files).toEqual([{ path: 'src/검색 파일.ts', kind: 'changed' }]);
  expect((await f.search.search({ query: '복구 src/missing.ts' })).total).toBe(0);
  expect((await f.search.search({ query: 'missing src/검색 파일.ts' })).total).toBe(0);
  expect((await f.search.search({ query: 'src/파일.ts' })).total).toBe(0);
  expect((await f.search.search({ query: '복구', filePath: 'src/검색' })).total).toBe(0);
  expect((await f.search.search({ query: '복구 src/검색 파일.ts', filePath: 'src/검색 파일.ts' })).total).toBe(1);
  expect((await f.search.search({ query: '복구 src/검색 파일.ts', filePath: 'src/other.ts' })).total).toBe(0);
});

test.each(['src/검색 파일.ts', './src/검색 파일.ts', `${cwd}/src/검색 파일.ts`, 'src/검색 파일.ts'.normalize('NFD')])(
  'matches a unified file query %s against the normalized reference', async query => {
    const f = await fixture();
    f.threads.set('changed', changedFileThread('changed', '검색 파일.ts', '- old\n+ fixed'));
    const result = await f.search.search({ query });
    expect(result.total).toBe(1);
    expect(result.hits[0]?.threadId).toBe('changed');
    expect(result.hits[0]?.snippet).not.toContain('src/');
  },
);

test('keeps natural language and paths outside the workspace as query text without path validation errors', async () => {
  const f = await fixture();
  f.threads.set('message', thread('message', '외부 /another/workspace/logs 경로와 ../outside.ts를 확인합니다.'));
  expect((await f.search.search({ query: '외부 /another/workspace/logs' })).total).toBe(1);
  expect((await f.search.search({ query: '../outside.ts' })).total).toBe(1);
  expect((await f.search.search({ query: '/another/workspace/missing' })).total).toBe(0);
  await failure(() => f.search.search({ query: '외부', filePath: '/another/workspace/logs' }), /workspace/);
});

test('reuses persisted histories and refreshes changed, active, expired and explicitly refreshed sessions', async () => {
  const f = await fixture();
  f.threads.set('one', thread('one', 'original'));
  await f.search.search({ query: 'original' });
  const restarted = new ChatHistorySearch(f.options);
  await restarted.search({ query: 'original' });
  expect(f.reads).toEqual(['one']);
  f.threads.set('one', thread('one', 'updated'));
  f.versions.set('one', 2);
  expect((await restarted.search({ query: 'updated' })).total).toBe(1);
  f.active.add('one');
  await restarted.search({ query: 'updated' });
  await restarted.search({ query: 'updated' });
  expect(f.reads).toHaveLength(4);
  f.active.clear();
  await restarted.search({ query: 'updated' });
  await restarted.search({ query: 'updated', refresh: true });
  f.advance(30_000);
  await restarted.search({ query: 'updated' });
  expect(f.reads).toHaveLength(7);
});

test('collapses inherited fork copies but preserves unrelated messages with identical prose', async () => {
  const f = await fixture();
  f.threads.set('root', thread('root', 'same content'));
  f.threads.set('fork', thread('fork', 'same content', 'root'));
  f.threads.set('independent', thread('independent', 'same content'));
  f.versions.set('fork', 2);
  const result = await f.search.search({ query: 'same content' });
  expect(result.total).toBe(2);
  expect(result.hits.map(hit => [hit.threadId, hit.duplicateCount])).toEqual([['fork', 1], ['independent', 0]]);
  f.threads.set('fork', thread('fork', 'different content', 'root'));
  const changed = await f.search.search({ query: 'content', refresh: true });
  expect(changed.total).toBe(3);
});

test('prunes missing sessions and removes derived copies even when the catalog becomes unavailable', async () => {
  const f = await fixture();
  f.threads.set('one', thread('one', 'keep'));
  f.threads.set('two', thread('two', 'remove'));
  await f.search.search({ query: 'keep' });
  expect(await readdir(f.directory)).toHaveLength(2);
  f.threads.delete('two');
  expect((await f.search.search({ query: 'remove' })).total).toBe(0);
  expect(await readdir(f.directory)).toHaveLength(1);
  const originalList = f.source.list;
  f.source.list = async () => { throw new Error('Catalog unavailable after deletion.'); };
  await f.search.remove(['one']);
  expect(await readdir(f.directory)).toHaveLength(0);
  f.source.list = originalList;
  expect((await f.search.search({ query: 'keep' })).total).toBe(0);
});

test('does not return stale matches after a failed refresh; rebuilds a corrupt cache', async () => {
  const f = await fixture();
  f.threads.set('one', thread('one', 'needle'));
  await f.search.search({ query: 'needle' });
  const [name] = await readdir(f.directory);
  await writeFile(join(f.directory, name!), '{broken');
  expect((await f.search.search({ query: 'needle' })).total).toBe(1);
  expect(f.reads).toHaveLength(2);
  f.failed.add('one');
  const result = await f.search.search({ query: 'needle', refresh: true });
  expect(result).toEqual({ hits: [], total: 0, indexedSessions: 0, unavailableSessions: ['one'] });
  expect(await readdir(f.directory)).toHaveLength(0);
});

test.each([1, 2, 3])('recompiles cache version %i before returning stale file references without requiring refresh', async (version) => {
  const f = await fixture();
  f.threads.set('one', thread('one', 'needle "Use the model APIs/pricing", Array.isArray and `src/정상 파일.ts`'));
  await f.search.search({ query: 'needle' });
  const [name] = await readdir(f.directory);
  const cachePath = join(f.directory, name!);
  const oldRecord = JSON.parse(await readFile(cachePath, 'utf8'));
  oldRecord.version = version;
  oldRecord.thread.entries[0].files = [{ path: 'Array.isArray', kind: 'mentioned' }];
  await writeFile(cachePath, JSON.stringify(oldRecord));

  const restarted = new ChatHistorySearch(f.options);
  const result = await restarted.search({ query: 'needle' });
  expect(result.hits[0]?.files).toEqual([{ path: 'src/정상 파일.ts', kind: 'mentioned' }]);
  expect(f.reads).toEqual(['one', 'one']);
  expect(JSON.parse(await readFile(cachePath, 'utf8')).version).toBe(CHAT_HISTORY_INDEX_VERSION);
  expect((await restarted.search({ query: 'needle', filePath: 'Array.isArray' })).total).toBe(0);
  expect(f.reads).toHaveLength(2);
});

test('deletion during indexing cannot resurrect a cached item or return its matches', async () => {
  const f = await fixture();
  f.threads.set('one', thread('one', 'needle'));
  const entered = createDeferred<void>();
  const finish = createDeferred<void>();
  const search = new ChatHistorySearch({ ...f.options, source: {
    list: f.source.list,
    async read(id: string) { entered.resolve(); await finish.promise; return f.source.read(id); },
  } });
  const pending = search.search({ query: 'needle' });
  await entered.promise;
  const removal = search.remove(['one']);
  finish.resolve();
  expect((await pending).total).toBe(0);
  await removal;
  expect(await readdir(f.directory).catch(() => [])).toHaveLength(0);
});

test('recompiles older spaced-path references before unified search can return a fabricated filename', async () => {
  const f = await fixture();
  f.threads.set('one', changedFileThread('one', '검색 파일.ts', '- old\n+ fixed'));
  await f.search.search({ query: 'fixed' });
  const [name] = await readdir(f.directory);
  const cachePath = join(f.directory, name!);
  const oldRecord = JSON.parse(await readFile(cachePath, 'utf8'));
  oldRecord.version = 3;
  oldRecord.thread.entries[0].files.push({ path: 'src/파일.ts', kind: 'mentioned' });
  await writeFile(cachePath, JSON.stringify(oldRecord));

  const restarted = new ChatHistorySearch(f.options);
  expect((await restarted.search({ query: 'src/파일.ts' })).total).toBe(0);
  expect((await restarted.search({ query: 'src/검색 파일.ts' })).total).toBe(1);
  expect(f.reads).toEqual(['one', 'one']);
});

test('rebuilds version four command references and retains command text and actual file searches', async () => {
  const f = await fixture();
  const command = 'wc -l src/first.ts src/second.ts';
  f.threads.set('one', thread('one', `Count lines with \`${command}\`.`));
  await f.search.search({ query: 'Count' });
  const [name] = await readdir(f.directory);
  const cachePath = join(f.directory, name!);
  const oldRecord = JSON.parse(await readFile(cachePath, 'utf8'));
  oldRecord.version = 4;
  oldRecord.thread.entries[0].files = [{ path: command, kind: 'mentioned' }];
  await writeFile(cachePath, JSON.stringify(oldRecord));

  const restarted = new ChatHistorySearch(f.options);
  const result = await restarted.search({ query: 'wc -l', filePath: 'src/first.ts' });
  expect(result.total).toBe(1);
  expect(result.hits[0]?.snippet).toContain(command);
  expect(result.hits[0]?.files).toEqual([
    { path: 'src/first.ts', kind: 'mentioned' }, { path: 'src/second.ts', kind: 'mentioned' },
  ]);
  expect((await restarted.search({ query: '', filePath: command })).total).toBe(0);
  expect((await restarted.search({ query: `${cwd}/src/second.ts` })).total).toBe(1);
  expect(f.reads).toEqual(['one', 'one']);
  expect(JSON.parse(await readFile(cachePath, 'utf8')).version).toBe(CHAT_HISTORY_INDEX_VERSION);
});

test('rejects a thread from another workspace and exposes partial indexing', async () => {
  const f = await fixture();
  f.threads.set('good', thread('good', 'needle'));
  f.threads.set('bad', { ...thread('bad', 'needle'), cwd: '/another/workspace' });
  const result = await f.search.search({ query: 'needle' });
  expect(result.hits.map(hit => hit.threadId)).toEqual(['good']);
  expect(result.unavailableSessions).toEqual(['bad']);
});

test('limits results and stores only deterministic source entries in the private derived directory', async () => {
  const f = await fixture();
  f.threads.set('one', thread('one', 'needle'));
  f.threads.set('two', thread('two', 'needle'));
  const result = await f.search.search({ query: 'needle', limit: 1 });
  expect(result.total).toBe(2);
  expect(result.hits).toHaveLength(1);
  const [name] = await readdir(f.directory);
  const data = JSON.parse(await readFile(join(f.directory, name!), 'utf8'));
  expect(data.cwd).toBe(cwd);
  expect(data.thread.entries[0].text).toBe('needle');
  await f.search.stop();
  await failure(() => f.search.search({ query: 'needle' }), /closed/);
});

test('validates search request and response at both bridge boundaries', () => {
  for (const value of [null, {}, { query: '' }, { query: 'x', refresh: 'true' }, { query: 'x', limit: 0 },
    { query: 'x', limit: 101 }, { query: 'x'.repeat(501) }, { query: 'x', filePath: false }]) {
    expect(() => chatHistorySearchRequest(value)).toThrow();
  }
  expect(chatHistorySearchRequest({ query: ' x ', refresh: false })).toEqual({ query: 'x', filePath: '', refresh: false, limit: 50 });
  expect(() => chatHistorySearchResponse({ hits: [], total: -1, indexedSessions: 0, unavailableSessions: [] })).toThrow();
});
