import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexConversationCatalog } from '../lib/codex-conversation-catalog.mts';
import type { JsonObject } from '../lib/codex-chat-types.mts';
import type { CodexConversationDeletion } from '../lib/codex-chat-account-continuity.mts';
import { recordValue } from '../lib/codex-service-utils.mts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function failure(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

async function fixture() {
  const directory = await mkdtemp('/private/tmp/cheshi-conversation-catalog-');
  directories.push(directory);
  const a = join(directory, 'account-a');
  const b = join(directory, 'account-b');
  const rollout = 'sessions/2026/09/11/rollout-source.jsonl';
  await mkdir(join(a, 'sessions/2026/09/11'), { recursive: true });
  await mkdir(b);
  const bytes = '{"type":"session_meta","payload":{"id":"source"}}\n';
  await writeFile(join(a, rollout), bytes);
  const source: JsonObject = {
    id: 'source', cwd: '/workspace', status: { type: 'idle' }, path: join(a, rollout),
    turns: [{ id: 'turn-one', status: 'completed', items: [{ type: 'commandExecution', id: 'tool-once' }] }],
    preview: 'A completed conversation', createdAt: 1, updatedAt: 2,
  };
  const threads = new Map<string, JsonObject[]>([['a', [source]], ['b', []]]);
  const calls: Array<{ profileId: string; method: string; params: JsonObject }> = [];
  let forkCount = 0;
  let forkError: Error | null = null;
  let loseForkResponse = false;
  let descendantStatus: string | null = null;
  let listHandler: ((profileId: string, params: JsonObject) => unknown) | null = null;
  const request = async (profileId: string, method: string, raw?: unknown): Promise<unknown> => {
    const params = recordValue(raw) ?? {};
    calls.push({ profileId, method, params });
    if (method === 'thread/list') {
      if (params.ancestorThreadId) return { data: descendantStatus ? [{ id: 'child', status: { type: descendantStatus } }] : [], nextCursor: null };
      return listHandler ? listHandler(profileId, params) : { data: threads.get(profileId) ?? [], nextCursor: null };
    }
    if (method === 'thread/read') return { thread: threads.get(profileId)?.find(thread => thread.id === params.threadId) };
    if (method === 'thread/goal/get') return { goal: { threadId: params.threadId, status: 'active', objective: 'Recorded objective' } };
    if (method === 'thread/fork') {
      forkCount += 1;
      if (forkError) throw forkError;
      const imported = { ...source, path: join(profileId === 'a' ? a : b, rollout) };
      const fork = { ...source, id: `fork-${forkCount}`, forkedFromId: params.threadId,
        path: join(profileId === 'a' ? a : b, `sessions/fork-${forkCount}.jsonl`) };
      await writeFile(String(fork.path), bytes);
      threads.set(profileId, [...(threads.get(profileId) ?? []), imported, fork]);
      if (loseForkResponse) throw new Error('fork response timed out');
      return { thread: fork };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  const options = {
    directory: join(directory, 'catalog'), cwd: '/workspace',
    profiles: async () => [{ id: 'a', home: a }, { id: 'b', home: b }], request,
  };
  const client = (id: string) => ({ request: (method: string, params?: unknown) => request(id, method, params) });
  return {
    directory, a, b, rollout, bytes, source, threads, calls, options, client,
    catalog: new CodexConversationCatalog(options),
    forkCount: () => forkCount,
    failFork: (error: Error | null) => { forkError = error; },
    loseForkResponse: () => { loseForkResponse = true; },
    descendants: (status: string) => { descendantStatus = status; },
    pages: (handler: (profileId: string, params: JsonObject) => unknown) => { listHandler = handler; },
  };
}

test('lists every page across accounts and excludes other workspaces and subagents', async () => {
  const f = await fixture();
  f.pages((profile, params) => profile === 'b' ? {
    data: [{ ...f.source, id: 'other', updatedAt: 4 }, { ...f.source, id: 'wrong', cwd: '/other' },
      { ...f.source, id: 'child', parentThreadId: 'source' }], nextCursor: null,
  } : params.cursor ? { data: [{ ...f.source, id: 'second-page', updatedAt: 3 }], nextCursor: null }
    : { data: [f.source], nextCursor: 'page-two' });
  const result = await f.catalog.list();
  expect(result.sessions.map(item => item.id)).toEqual(['other', 'second-page', 'source']);
  expect(result.sessions[0]?.profileId).toBe('b');
  expect(f.calls.filter(call => call.method === 'thread/list').every(call =>
    Array.isArray(call.params.modelProviders) && call.params.modelProviders.length === 0
    && Array.isArray(call.params.sourceKinds) && call.params.sourceKinds.includes('appServer'))).toBe(true);
});

test('refuses repeated pagination cursors instead of looping', async () => {
  const f = await fixture();
  f.pages(() => ({ data: [], nextCursor: 'repeat' }));
  await failure(f.catalog.list(), 'repeated cursor');
});

test('excludes internal history whose list response omits the parent without extra reads', async () => {
  const f = await fixture();
  const internal = { ...f.source, id: 'guardian', source: { subAgent: { other: 'guardian' } } };
  f.threads.set('a', [f.source, { ...internal, parentThreadId: 'source' }]);
  f.pages(profile => ({ data: profile === 'a' ? [f.source, internal] : [], nextCursor: null }));
  expect((await f.catalog.list()).sessions.map(item => item.id)).toEqual(['source']);
  expect(f.calls.every(call => call.method === 'thread/list')).toBe(true);
  await failure(f.catalog.resolve('guardian', 'b', f.client('b')), 'not found');
  expect(f.forkCount()).toBe(0);
});

test('refuses malformed pagination cursors instead of dropping the remaining history', async () => {
  const f = await fixture();
  f.pages(() => ({ data: [], nextCursor: 1 }));
  await failure(f.catalog.list(), 'response format is invalid');
});

test('same-account opening does not copy, fork or send inference requests', async () => {
  const f = await fixture();
  expect(await f.catalog.resolve('source', 'a', f.client('a'))).toBe('source');
  expect(f.calls.every(call => call.method === 'thread/list')).toBe(true);
});

test('copies only completed rollout and forks once with a deferred goal, preserving source', async () => {
  const f = await fixture();
  await writeFile(join(f.a, 'auth.json'), 'private credential placeholder');
  const loaded: string[] = [];
  const id = await f.catalog.resolve('source', 'b', f.client('b'), threadId => loaded.push(threadId));
  expect(id).toBe('fork-1');
  expect(loaded).toEqual(['fork-1']);
  expect(await readFile(join(f.a, f.rollout), 'utf8')).toBe(f.bytes);
  expect(await readFile(join(f.b, f.rollout), 'utf8')).toBe(f.bytes);
  expect((await stat(join(f.b, f.rollout))).mode & 0o777).toBe(0o600);
  await failure(readFile(join(f.b, 'auth.json')), 'ENOENT');
  expect(f.calls.find(call => call.method === 'thread/fork')?.params).toEqual({
    threadId: 'source', lastTurnId: 'turn-one', deferGoalContinuation: true,
  });
  expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
  expect(await f.catalog.locations(id)).toEqual([
    { profileId: 'a', threadId: 'source' }, { profileId: 'b', threadId: 'source' }, { profileId: 'b', threadId: 'fork-1' },
  ]);
  expect((await f.catalog.list()).sessions.map(item => item.id)).toEqual(['fork-1']);
});

test('new catalog instance resolves saved aliases without another fork', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  const restarted = new CodexConversationCatalog(f.options);
  expect(await restarted.resolve('source', 'b', f.client('b'))).toBe('fork-1');
  expect(f.forkCount()).toBe(1);
});

test('an existing handoff inherits the original name without rewriting history or the ledger', async () => {
  const f = await fixture();
  f.source.name = 'Aside처럼 구현하기';
  await f.catalog.resolve('source', 'b', f.client('b'));
  // Imported rollouts and forks can omit the name stored in the source account database.
  for (const thread of f.threads.get('b')!) thread.name = null;
  const fork = f.threads.get('b')!.find(thread => thread.id === 'fork-1')!;
  fork.preview = '초기 실행시 0 으로 잡힙니다.';
  fork.updatedAt = 10;
  const ledger = await readFile(join(f.options.directory, 'conversations.json'), 'utf8');
  f.calls.splice(0);
  const restarted = new CodexConversationCatalog(f.options);
  const result = await restarted.list();
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({ id: 'fork-1', profileId: 'b', title: 'Aside처럼 구현하기',
    preview: '초기 실행시 0 으로 잡힙니다.', updatedAt: 10 });
  expect(fork.name).toBeNull();
  expect(f.calls.every(call => call.method === 'thread/list')).toBe(true);
  expect(await readFile(join(f.options.directory, 'conversations.json'), 'utf8')).toBe(ledger);
  expect(await readFile(join(f.a, f.rollout), 'utf8')).toBe(f.bytes);
});

test('an unnamed handoff retains the original preview title when neither account has a name', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  const fork = f.threads.get('b')!.find(thread => thread.id === 'fork-1')!;
  fork.name = '  ';
  fork.preview = 'The next question';
  expect((await f.catalog.list()).sessions[0]).toMatchObject({
    id: 'fork-1', title: 'A completed conversation', preview: 'The next question',
  });
});

test('an explicit name on the current continuation takes priority over the original name', async () => {
  const f = await fixture();
  f.source.name = 'Original title';
  await f.catalog.resolve('source', 'b', f.client('b'));
  f.threads.get('b')!.find(thread => thread.id === 'fork-1')!.name = 'Renamed conversation';
  expect((await f.catalog.list()).sessions[0]?.title).toBe('Renamed conversation');
});

test('successive handoffs inherit the most recent explicit name using the account and thread together', async () => {
  const f = await fixture();
  f.source.name = 'Original title';
  await f.catalog.resolve('source', 'b', f.client('b'));
  f.threads.get('b')!.find(thread => thread.id === 'fork-1')!.name = 'Renamed before switching back';
  await f.catalog.resolve('fork-1', 'a', f.client('a'));
  f.threads.get('a')!.find(thread => thread.id === 'fork-2')!.name = null;
  expect((await f.catalog.list()).sessions).toMatchObject([
    { id: 'fork-2', profileId: 'a', title: 'Renamed before switching back' },
  ]);
});

test('missing predecessor metadata keeps the current preview instead of borrowing an unrelated name', async () => {
  const f = await fixture();
  f.source.name = 'Original title';
  await f.catalog.resolve('source', 'b', f.client('b'));
  const fork = f.threads.get('b')!.find(thread => thread.id === 'fork-1')!;
  fork.name = null;
  fork.preview = 'Current preview';
  f.threads.set('a', [{ ...f.source, id: 'unrelated', name: 'Unrelated title' }]);
  f.threads.set('b', [fork]);
  expect((await f.catalog.list()).sessions.find(session => session.id === 'fork-1')?.title).toBe('Current preview');
});

test('read-only requests follow the latest alias owner without starting or resuming a turn', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  f.calls.splice(0);
  const response = recordValue(await f.catalog.read('source', 'thread/read', { includeTurns: true, threadId: 'wrong' }));
  expect(recordValue(response?.thread)?.id).toBe('fork-1');
  const goal = recordValue(await f.catalog.read('source', 'thread/goal/get'));
  expect(recordValue(goal?.goal)?.threadId).toBe('fork-1');
  expect(f.calls).toEqual([
    { profileId: 'b', method: 'thread/read', params: { includeTurns: true, threadId: 'fork-1' } },
    { profileId: 'b', method: 'thread/goal/get', params: { threadId: 'fork-1' } },
  ]);
  expect(f.forkCount()).toBe(1);
});

test('read discovers the original owner and keeps uncertain histories readable while rejecting deleted histories', async () => {
  const f = await fixture();
  const response = recordValue(await f.catalog.read('source', 'thread/read'));
  expect(recordValue(response?.thread)?.id).toBe('source');
  f.failFork(new Error('connection lost'));
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'connection lost');
  const uncertain = recordValue(await f.catalog.read('source', 'thread/read'));
  expect(recordValue(uncertain?.thread)?.id).toBe('source');
  await f.catalog.forget('source');
  await failure(f.catalog.read('source', 'thread/goal/get'), 'deleted');
});

test('concurrent catalog instances serialize the same handoff', async () => {
  const f = await fixture();
  const second = new CodexConversationCatalog(f.options);
  expect(await Promise.all([
    f.catalog.resolve('source', 'b', f.client('b')), second.resolve('source', 'b', f.client('b')),
  ])).toEqual(['fork-1', 'fork-1']);
  expect(f.forkCount()).toBe(1);
});

test('switching back forks the latest completed continuation and retains one list entry', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  expect(await f.catalog.resolve('source', 'a', f.client('a'))).toBe('fork-2');
  expect(f.calls.filter(call => call.method === 'thread/fork').at(-1)?.params.threadId).toBe('fork-1');
  expect((await f.catalog.list()).sessions.map(item => item.id)).toEqual(['fork-2']);
  expect(await f.catalog.resolve('fork-1', 'a', f.client('a'))).toBe('fork-2');
});

for (const status of ['inProgress', 'unknown']) {
  test(`refuses ${status} turns without copying or forking`, async () => {
    const f = await fixture();
    f.source.turns = [{ id: 'turn-one', status }];
    await failure(f.catalog.resolve('source', 'b', f.client('b')), 'unfinished or uncertain');
    expect(f.forkCount()).toBe(0);
    await failure(readFile(join(f.b, f.rollout)), 'ENOENT');
  });
}

for (const status of ['failed', 'interrupted']) {
  test(`preserves a terminal ${status} turn without resubmitting it`, async () => {
    const f = await fixture();
    f.source.turns = [{ id: 'terminal-turn', status, items: [{ type: 'commandExecution', id: 'already-executed' }] }];
    const bytes = `${JSON.stringify(f.source.turns)}\n`;
    await writeFile(join(f.a, f.rollout), bytes);
    expect(await f.catalog.resolve('source', 'b', f.client('b'))).toBe('fork-1');
    expect(await readFile(join(f.b, f.rollout), 'utf8')).toBe(bytes);
    expect(f.calls.find(call => call.method === 'thread/fork')?.params.lastTurnId).toBe('terminal-turn');
    expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
  });
}

test('refuses active descendants even when the parent is complete', async () => {
  const f = await fixture();
  f.descendants('active');
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'subagent is still active');
  expect(f.forkCount()).toBe(0);
});

test('never overwrites a divergent imported file', async () => {
  const f = await fixture();
  await mkdir(join(f.b, 'sessions/2026/09/11'), { recursive: true });
  await writeFile(join(f.b, f.rollout), 'divergent conversation');
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'different conversation snapshot');
  expect(await readFile(join(f.b, f.rollout), 'utf8')).toBe('divergent conversation');
  expect(f.forkCount()).toBe(0);
});

test('rejects a target sessions symlink before creating nested directories', async () => {
  const f = await fixture();
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await createSymbolicLink(outside, join(f.b, 'sessions'));
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'symbolic links');
  await failure(readFile(join(outside, '2026/09/11/rollout-source.jsonl')), 'ENOENT');
  expect(f.forkCount()).toBe(0);
});

test('rejects source rollout paths outside their account sessions', async () => {
  const f = await fixture();
  f.source.path = join(f.directory, 'outside.jsonl');
  await writeFile(String(f.source.path), 'private data');
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'outside its account home');
  expect(f.forkCount()).toBe(0);
});

test('records uncertain fork outcomes durably and never repeats the request', async () => {
  const f = await fixture();
  f.failFork(new Error('connection lost'));
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'connection lost');
  await failure(new CodexConversationCatalog(f.options).resolve('source', 'b', f.client('b')), 'uncertain outcome');
  expect(f.forkCount()).toBe(1);
});

test('definitively rejected fork requests can retry after restart', async () => {
  const f = await fixture();
  const rejected = new Error('fork rejected');
  rejected.name = 'CodexRequestRejectedError';
  f.failFork(rejected);
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'fork rejected');
  f.failFork(null);
  const restarted = new CodexConversationCatalog(f.options);
  expect(await restarted.resolve('source', 'b', f.client('b'))).toBe('fork-2');
  expect(f.forkCount()).toBe(2);
});

test('recovers a fork whose response was lost after restart without repeating the fork request', async () => {
  const f = await fixture();
  f.loseForkResponse();
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'timed out');
  const restarted = new CodexConversationCatalog(f.options);
  expect((await restarted.list()).sessions.map(session => session.id)).toEqual(['fork-1']);
  expect(await restarted.owner('source')).toEqual({ profileId: 'b', threadId: 'fork-1' });
  expect(await restarted.resolve('source', 'b', f.client('b'))).toBe('fork-1');
  expect((await restarted.locations('source')).some(item => item.threadId === 'fork-1')).toBe(true);
  expect(f.forkCount()).toBe(1);
  expect(f.calls.some(call => call.method === 'turn/start' || call.method === 'thread/resume')).toBe(false);
});

test('excludes preexisting forks when recovering an uncertain outcome', async () => {
  const f = await fixture();
  f.threads.set('b', [{ ...f.source, id: 'old-fork', forkedFromId: 'source' }]);
  f.loseForkResponse();
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'timed out');
  expect(await new CodexConversationCatalog(f.options).owner('source')).toEqual({ profileId: 'b', threadId: 'fork-1' });
  expect(f.forkCount()).toBe(1);
});

test('ambiguous recovery leaves the original readable and permits a new request in its original account', async () => {
  const f = await fixture();
  f.loseForkResponse();
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'timed out');
  f.threads.get('b')!.push({ ...f.source, id: 'other-new-fork', forkedFromId: 'source' });
  const restarted = new CodexConversationCatalog(f.options);
  expect(await restarted.owner('source')).toEqual({ profileId: 'a', threadId: 'source' });
  expect(recordValue(recordValue(await restarted.read('source', 'thread/read'))?.thread)?.id).toBe('source');
  expect(await restarted.resolve('source', 'a', f.client('a'))).toBe('source');
  await failure(restarted.resolve('source', 'b', f.client('b')), 'original account remains readable');
  await failure(restarted.locations('source'), 'original account remains readable');
  expect(f.forkCount()).toBe(1);
});

test('recovery never replaces newer original-account turns with an older fork', async () => {
  const f = await fixture();
  f.loseForkResponse();
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'timed out');
  f.source.turns = [...f.source.turns as JsonObject[], { id: 'new-original-turn', status: 'completed', items: [] }];
  const restarted = new CodexConversationCatalog(f.options);
  expect(await restarted.owner('source')).toEqual({ profileId: 'a', threadId: 'source' });
  await failure(restarted.resolve('source', 'b', f.client('b')), 'uncertain outcome');
  expect(f.forkCount()).toBe(1);
});

test('legacy pending records preserve source read access without blindly repeating the fork', async () => {
  const f = await fixture();
  await mkdir(f.options.directory);
  await writeFile(join(f.options.directory, 'conversations.json'), JSON.stringify({ version: 1, chains: [{
    current: { profileId: 'a', threadId: 'source' }, locations: [{ profileId: 'a', threadId: 'source' }], pending: true,
  }] }));
  expect(await f.catalog.owner('source')).toEqual({ profileId: 'a', threadId: 'source' });
  expect(await f.catalog.resolve('source', 'a', f.client('a'))).toBe('source');
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'uncertain outcome');
  expect(f.forkCount()).toBe(0);
});

test('deletion tombstones suppress all source aliases after restart', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  await f.catalog.forget('fork-1');
  const restarted = new CodexConversationCatalog(f.options);
  expect((await restarted.list()).sessions).toEqual([]);
  await failure(restarted.resolve('source', 'b', f.client('b')), 'deleted');
});

test('confirmed deletion persists all aliases and a retry entry after the current thread disappears', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  const aliases = await f.catalog.locations('fork-1');
  const deletion = { profileId: 'b', threadId: 'fork-1', threadIds: ['fork-1', 'child'] };
  await f.catalog.confirmDeletion('fork-1', deletion);
  f.threads.set('b', f.threads.get('b')!.filter(thread => thread.id !== 'fork-1'));
  const restarted = new CodexConversationCatalog(f.options);
  expect(await restarted.deletionProgress('source')).toEqual([deletion]);
  expect(await restarted.locations('source')).toEqual(aliases);
  expect(await restarted.locations('fork-1')).toEqual(aliases);
  const result = await restarted.list();
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({ id: 'fork-1', title: 'Deletion incomplete',
    preview: 'Retry deleting this conversation to finish removing its history.', status: 'notLoaded', profileId: 'b' });
  expect(typeof result.sessions[0]?.createdAt).toBe('number');
  expect(typeof result.sessions[0]?.updatedAt).toBe('number');
  expect((await stat(join(f.options.directory, 'conversations.json'))).mode & 0o777).toBe(0o600);
  f.calls.splice(0);
  for (const alias of ['source', 'fork-1']) {
    await failure(restarted.owner(alias), 'Retry deleting it before continuing');
    await failure(restarted.read(alias, 'thread/read'), 'Retry deleting it before continuing');
    await failure(restarted.read(alias, 'thread/goal/get'), 'Retry deleting it before continuing');
    for (const profileId of ['a', 'b']) {
      await failure(restarted.resolve(alias, profileId, f.client(profileId)), 'Retry deleting it before continuing');
    }
  }
  expect(f.calls).toHaveLength(0);
  expect(f.forkCount()).toBe(1);
});

test('deletion confirmations are idempotent across aliases and catalog instances without exposing mutable state', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  const restarted = new CodexConversationCatalog(f.options);
  const first = { profileId: 'b', threadId: 'fork-1', threadIds: ['fork-1', 'child'] };
  const second = { profileId: 'a', threadId: 'source', threadIds: ['source'] };
  await Promise.all([f.catalog.confirmDeletion('source', first), restarted.confirmDeletion('fork-1', second)]);
  const contents = await readFile(join(f.options.directory, 'conversations.json'), 'utf8');
  await restarted.confirmDeletion('source', { ...first, threadIds: ['child', 'fork-1'] });
  expect(await readFile(join(f.options.directory, 'conversations.json'), 'utf8')).toBe(contents);
  const progress = await restarted.deletionProgress('source');
  expect(progress).toEqual([first, second]);
  progress[0]!.threadIds.push('not-deleted');
  first.threadIds.push('not-deleted');
  expect((await restarted.deletionProgress('fork-1'))[0]?.threadIds).toEqual(['fork-1', 'child']);
  await failure(restarted.confirmDeletion('source', first), 'conflicts with an earlier confirmation');
  expect(await readFile(join(f.options.directory, 'conversations.json'), 'utf8')).toBe(contents);
});

test('retry entry survives every physical deletion until the catalog forget operation succeeds', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  for (const location of await f.catalog.locations('fork-1')) {
    await f.catalog.confirmDeletion('fork-1', { ...location, threadIds: [location.threadId] });
  }
  f.threads.clear();
  const restarted = new CodexConversationCatalog(f.options);
  expect((await restarted.list()).sessions.map(session => session.id)).toEqual(['fork-1']);
  expect(await restarted.deletionProgress('fork-1')).toHaveLength(3);
  await restarted.forget('source');
  const finished = new CodexConversationCatalog(f.options);
  expect((await finished.list()).sessions).toHaveLength(0);
  await failure(finished.confirmDeletion('fork-1', { profileId: 'b', threadId: 'fork-1', threadIds: ['fork-1'] }), 'deleted');
  await failure(finished.deletionProgress('source'), 'deleted');
});

test('global catalog shows incomplete deletion only in its originating workspace', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  const deletion = { profileId: 'b', threadId: 'fork-1', threadIds: ['fork-1'] };
  await f.catalog.confirmDeletion('fork-1', deletion);
  f.threads.set('a', [f.source, { ...f.source, id: 'other-workspace', cwd: '/other' }]);
  const other = new CodexConversationCatalog({ ...f.options, cwd: '/other' });
  expect((await other.list()).sessions.map(session => session.id)).toEqual(['other-workspace']);
  await failure(other.locations('source'), 'different workspace');
  await failure(other.deletionProgress('fork-1'), 'different workspace');
  await failure(other.confirmDeletion('fork-1', deletion), 'different workspace');
  expect((await f.catalog.list()).sessions.map(session => session.id)).toEqual(['fork-1']);
});

test('deletion progress rejects malformed and conflicting records before making provider requests', async () => {
  const f = await fixture();
  await mkdir(f.options.directory);
  const current = { profileId: 'b', threadId: 'fork-1' };
  const locations = [{ profileId: 'a', threadId: 'source' }, current];
  const valid = { ...current, threadIds: ['fork-1'] };
  const malformed: unknown[] = [null, {}, [null], [{ ...valid, profileId: 'unknown' }],
    [{ ...valid, threadId: 'source' }], [{ ...valid, threadIds: [] }], [{ ...valid, threadIds: ['child'] }],
    [{ ...valid, threadIds: ['fork-1', 1] }], [{ ...valid, threadIds: ['fork-1', ''] }],
    [{ ...valid, threadIds: ['fork-1', ' '] }], [{ ...valid, threadIds: ['fork-1', 'fork-1'] }], [valid, valid]];
  for (const confirmedDeletions of malformed) {
    await writeFile(join(f.options.directory, 'conversations.json'), JSON.stringify({ version: 1,
      chains: [{ current, locations, confirmedDeletions, deletionCwd: '/workspace' }] }));
    await failure(new CodexConversationCatalog(f.options).deletionProgress('source'), 'deletion progress');
  }
  for (const deletionCwd of [undefined, null, 1, '', 'workspace', '/workspace/../other']) {
    await writeFile(join(f.options.directory, 'conversations.json'), JSON.stringify({ version: 1,
      chains: [{ current, locations, confirmedDeletions: [valid], deletionCwd }] }));
    await failure(new CodexConversationCatalog(f.options).list(), 'deletion workspace record is invalid');
  }
  await writeFile(join(f.options.directory, 'conversations.json'), JSON.stringify({ version: 1,
    chains: [{ current, locations, confirmedDeletions: [valid], deletionCwd: '/workspace', pending: true }] }));
  await failure(new CodexConversationCatalog(f.options).deletionProgress('source'), 'unfinished handoff');
  expect(f.calls).toHaveLength(0);
});

test('confirming deletion validates the physical account, root and descendant list before saving', async () => {
  const f = await fixture();
  await f.catalog.resolve('source', 'b', f.client('b'));
  const before = await readFile(join(f.options.directory, 'conversations.json'), 'utf8');
  const invalid: unknown[] = [{ profileId: 'a', threadId: 'fork-1', threadIds: ['fork-1'] },
    { profileId: 'b', threadId: 'fork-1', threadIds: ['child'] },
    { profileId: 'b', threadId: 'fork-1', threadIds: ['fork-1', 1] },
    { profileId: 'b', threadId: 'fork-1', threadIds: ['fork-1', 'fork-1'] }];
  for (const deletion of invalid) {
    await failure(f.catalog.confirmDeletion('source', deletion as CodexConversationDeletion), 'deletion progress record is invalid');
  }
  expect(await readFile(join(f.options.directory, 'conversations.json'), 'utf8')).toBe(before);
  expect(await f.catalog.deletionProgress('source')).toEqual([]);
});

test('uncertain handoffs cannot acquire deletion confirmations', async () => {
  const f = await fixture();
  f.failFork(new Error('connection lost'));
  await failure(f.catalog.resolve('source', 'b', f.client('b')), 'connection lost');
  await failure(f.catalog.confirmDeletion('source', { profileId: 'a', threadId: 'source', threadIds: ['source'] }), 'uncertain outcome');
  expect(await f.catalog.deletionProgress('source')).toEqual([]);
  expect(recordValue(recordValue(await f.catalog.read('source', 'thread/read'))?.thread)?.id).toBe('source');
});

test('single conversations without a handoff chain do not create unnecessary deletion records', async () => {
  const f = await fixture();
  await f.catalog.confirmDeletion('source', { profileId: 'a', threadId: 'source', threadIds: ['source'] });
  expect(await f.catalog.deletionProgress('source')).toEqual([]);
  await failure(stat(join(f.options.directory, 'conversations.json')), 'ENOENT');
  expect(f.calls).toHaveLength(0);
});
