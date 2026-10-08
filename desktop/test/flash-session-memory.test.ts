import { expect, test } from 'bun:test';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { digest, sessionDocuments, workspaceMemoryAccount } from '../lib/flash/sources.mts';
import { searchSessions } from '../lib/chat-search-source.mts';
import { account, deferred, fixtureSummary, readRequest, flashFixture, history, rejection, session } from './flash-test-helpers.ts';

test('only saved parent messages are indexed, with stable source ids and changing revisions', () => {
  const catalog = searchSessions({ sessions: [session()] })[0]!;
  const first = sessionDocuments(history(), '/workspace', catalog);
  const edited = sessionDocuments(history('Edited source'), '/workspace', catalog);
  expect(first[0]?.source_id).toBe(edited[0]?.source_id);
  expect(first[0]?.revision).not.toBe(edited[0]?.revision);
  expect(sessionDocuments({ thread: { ...history().thread, ephemeral: true } }, '/workspace', catalog)).toEqual([]);
  expect(sessionDocuments({ thread: { ...history().thread, parentThreadId: 'parent' } }, '/workspace', catalog)).toEqual([]);
  expect(() => sessionDocuments(history(), '/another-workspace', catalog)).toThrow();
  const running = history(); running.thread.turns[0]!.status = 'inProgress';
  expect(sessionDocuments(running, '/workspace', catalog)).toEqual([]);
});

test('embedding titles obey the service limit without changing original titles or message text', () => {
  const body = '대화 원문과 결정사항은 그대로 보존합니다.';
  for (const length of [1999, 2000, 2001, 4174, 6090, 6553]) {
    const title = '가'.repeat(length);
    const catalog = searchSessions({ sessions: [{ ...session(), title }] })[0]!;
    const [source] = sessionDocuments(history(body), '/workspace', catalog);
    expect([...source!.document.title]).toHaveLength(Math.min(length, 2000));
    expect(source!.document.title).toBe(title.slice(0, 2000));
    expect(source!.document.text).toBe(body);
    expect(catalog.title).toBe(title);
  }
  const title = '가'.repeat(1999) + '😀끝';
  const catalog = searchSessions({ sessions: [{ ...session(), title }] })[0]!;
  const [source] = sessionDocuments(history(body), '/workspace', catalog);
  expect(source!.document.title).toBe('가'.repeat(1999) + '😀');
  expect([...source!.document.title]).toHaveLength(2000);
  expect(catalog.title).toBe(title);
  const bounded = sessionDocuments(history(body), '/workspace', { ...catalog, title: source!.document.title })[0]!;
  expect(source!.source_id).toBe(bounded.source_id);
  expect(source!.revision).toBe(bounded.revision);
});

test('source revisions reconcile updates, deletion and restart without reembedding unchanged messages', async () => {
  const f = await flashFixture();
  let sessions = [session(), session('other', 'b')];
  let raw = history();
  const options = { workspace: '/workspace', host: f.host, summarize: fixtureSummary, source: { list: async () => ({ sessions }), read: async () => raw } };
  const first = new FlashSessionMemory(options); first.accounts(account());
  const signal = new AbortController().signal;
  try {
    const result = await first.execute('memory_search', { query: 'memory' }, 'current', signal) as { matches: { source_id: string }[] };
    expect(result.matches).toHaveLength(1);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(1);
    expect(f.grants.size).toBe(0);
    await first.dispose();
    const restarted = new FlashSessionMemory(options); restarted.accounts(account());
    try {
      await restarted.synchronize();
      expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(1);
      raw = history('Changed source');
      await restarted.synchronize();
      expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
      const read = await restarted.execute('memory_read', readRequest(), 'current', signal) as { summary: string };
      expect(read.summary).toBe('Changed source');
      sessions = [];
      restarted.changed({ type: 'sessions-deleted', threadIds: ['s'] });
      const removed = await restarted.execute('memory_search', { query: 'memory' }, 'current', signal);
      expect(removed).toEqual({ matches: [] });
      expect(f.methods).toContain('sessions.delete');
    } finally { await restarted.dispose(); }
  } finally { await first.dispose(); await f.close(); }
});

test('account switching cancels old results and follows the connected profile snapshot', async () => {
  const f = await flashFixture();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session(), session('b-session', 'b')] }),
      read: async (id, profile) => history(`Only account ${profile}`, id) } });
  memory.accounts(account());
  const entered = deferred<void>(); const resume = deferred<void>();
  f.searchHook(async () => { entered.resolve(); await resume.promise; });
  try {
    const pending = rejection(() => memory.execute('memory_search', { query: 'q' }, 'current', new AbortController().signal));
    await entered.promise;
    memory.accounts(account('b'));
    resume.resolve();
    expect((await pending).message).toContain('cancel');
    const result = await memory.execute('memory_search', { query: 'q' }, 'current', new AbortController().signal) as { matches: { text: string }[] };
    expect(result.matches.map(item => item.text)).toEqual(['Only account b']);
    memory.accounts(account('b', false));
    expect((await rejection(() => memory.synchronize())).message).toContain('Sign in');
  } finally { resume.resolve(); await memory.dispose(); await f.close(); }
});

test('source changes during inference cannot return stale excerpts', async () => {
  const f = await flashFixture(); let raw = history();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session()] }), read: async () => raw } });
  memory.accounts(account());
  f.searchHook(async () => { raw = history('Changed while searching'); });
  try {
    const error = await rejection(() => memory.execute('memory_search', { query: 'q' }, 'current', new AbortController().signal));
    expect(error.message).toContain('Source changed');
    expect(f.grants.size).toBe(0);
  } finally { await memory.dispose(); await f.close(); }
});

test('reindex replaces legacy selected spans and restores omitted messages from history', async () => {
  const f = await flashFixture();
  const original = '작업 중입니다.\n\n메뉴 배경은 투명하고 테두리는 1px입니다.';
  const raw = history(original);
  raw.thread.turns[0]!.items.push({ id: 'omitted', type: 'agentMessage', text: '추가 결정도 원문 그대로 보존합니다.' });
  const catalog = searchSessions({ sessions: [session()] })[0]!;
  const sources = sessionDocuments(raw, '/workspace', catalog);
  const source = sources[0]!;
  const { ordinal: _ordinal, ...content } = source.document;
  const legacyRevision = digest(['frozen-session-v1', content]);
  const scope = JSON.stringify(['/workspace', workspaceMemoryAccount('/workspace')]);
  f.stored.set(scope, new Map([[source.source_id, {
    revision: legacyRevision,
    document: { ...source.document, ordinal: 7, ...{ search_ranges: [{ start: 10, end: [...original].length }] } },
  }]]));
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session()] }), read: async () => raw } });
  memory.accounts(account());
  try {
    await memory.synchronize();
    const stored = f.stored.get(scope)!;
    expect(stored.size).toBe(2);
    expect(stored.get(source.source_id)!.revision).not.toBe(legacyRevision);
    expect(stored.get(source.source_id)!.document).toEqual({ ...source.document, ordinal: 7 });
    expect(stored.get(sources[1]!.source_id)!.document.text).toBe(raw.thread.turns[0]!.items[1]!.text);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    await memory.synchronize();
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
  } finally { await memory.dispose(); await f.close(); }
});

test('completed turns ingest complete visible messages and omit execution and compaction records', async () => {
  const f = await flashFixture();
  const question = '배경은 어떻게 할까요?';
  const answer = '작업 중입니다.\n\n투명하게 유지하겠습니다.';
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session()] }), read: async () => ({ thread: {
      id: 's', cwd: '/workspace', turns: [{ id: 'turn', status: 'completed', items: [
        { id: 'q', type: 'userMessage', content: [{ type: 'text', text: question }] },
        { id: 'tool', type: 'commandExecution', command: 'echo test', aggregatedOutput: 'Execution log' },
        { id: 'compact', type: 'contextCompaction', text: 'Compaction snapshot' },
        { id: 'a', type: 'agentMessage', text: answer },
      ] }],
    } }) } });
  memory.accounts(account());
  try {
    memory.changed({ type: 'turn-completed', status: 'completed', threadId: 's', turnId: 'turn' });
    await memory.synchronize();
    const documents = [...f.stored.values()].flatMap(scope => [...scope.values()].map(item => item.document));
    expect(documents.map(item => [item.kind, item.text, item.turnId])).toEqual([
      ['user', question, 'turn'], ['assistant', answer, 'turn'],
    ]);
    expect(documents.every(item => !('search_ranges' in item))).toBe(true);
  } finally { await memory.dispose(); await f.close(); }
});

test('all connected accounts share workspace ranking and reads without reembedding on account selection', async () => {
  const f = await flashFixture();
  const accounts = (activeId = 'a') => ({ activeId, profiles: [...account('a').profiles, ...account('b').profiles] });
  const reads: string[] = [];
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session('a-session', 'a'), session('b-session', 'b'), session('excluded', 'c')] }),
      read: async (id, profile) => { reads.push(profile!); return history(`Decision from ${profile}`, id); } } });
  const signal = new AbortController().signal;
  memory.accounts(accounts());
  try {
    const result = await memory.execute('memory_search', { query: 'Decision' }, 'caller', signal) as {
      matches: { source_id: string; text: string }[];
    };
    expect(result.matches.map(item => item.text)).toEqual(['Decision from a', 'Decision from b']);
    expect(memory.status()).toMatchObject({ state: 'ready', processed: 2, total: 2 });
    expect(reads).not.toContain('c');
    const read = await memory.execute('memory_read', readRequest('b-session'), 'caller', signal);
    expect(read).toMatchObject({ summary: 'Decision from b' });
    expect(f.stored.size).toBe(1);
    expect(f.methods.filter(method => method === 'memory_search')).toHaveLength(1);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    memory.accounts(accounts('b'));
    const switched = await memory.execute('memory_search', { query: 'Decision' }, 'caller', signal);
    expect(switched).toEqual(result);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    expect(f.grants.size).toBe(0);
  } finally { await memory.dispose(); await f.close(); }
});

test('adding or disconnecting a non-active account resynchronizes the shared workspace', async () => {
  const f = await flashFixture();
  const a = account('a');
  const both = { ...a, profiles: [...a.profiles, ...account('b').profiles] };
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session('a-session', 'a'), session('b-session', 'b')] }),
      read: async (id, profile) => history(`Decision from ${profile}`, id) } });
  memory.accounts(a);
  try {
    await memory.synchronize();
    expect(memory.status().total).toBe(1);
    memory.accounts(both);
    expect(memory.status().state).toBe('preparing');
    await memory.synchronize();
    expect(memory.status().total).toBe(2);
    memory.accounts({ ...a, profiles: [...a.profiles, ...account('b', false).profiles] });
    await memory.synchronize();
    expect(memory.status().total).toBe(1);
    const documents = [...f.stored.values()].flatMap(scope => [...scope.values()]);
    expect(documents.map(item => item.document.text)).toEqual(['Decision from a']);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    expect(f.methods).toContain('source.delete');
  } finally { await memory.dispose(); await f.close(); }
});

test('a failed account read prevents partial workspace readiness and retries all sources', async () => {
  const f = await flashFixture();
  let fail = true;
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session('a-session', 'a'), session('b-session', 'b')] }),
      read: async (id, profile) => {
        if (profile === 'b' && fail) throw new Error('Read unavailable');
        return history(`Decision from ${profile}`, id);
      } } });
  memory.accounts({ activeId: 'a', profiles: [...account('a').profiles, ...account('b').profiles] });
  try {
    await rejection(() => memory.synchronize());
    expect(memory.status().state).toBe('error');
    expect(f.methods).not.toContain('source.ingest');
    expect(f.methods).not.toContain('sync.complete');
    fail = false;
    memory.retry();
    await memory.synchronize();
    expect(memory.status()).toMatchObject({ state: 'ready', processed: 2, total: 2 });
  } finally { await memory.dispose(); await f.close(); }
});

test('disconnecting another account cancels an in-flight workspace search', async () => {
  const f = await flashFixture();
  const entered = deferred<void>(); const resume = deferred<void>();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host, summarize: fixtureSummary,
    source: { list: async () => ({ sessions: [session('a-session', 'a'), session('b-session', 'b')] }),
      read: async (id, profile) => history(`Decision from ${profile}`, id) } });
  memory.accounts({ activeId: 'a', profiles: [...account('a').profiles, ...account('b').profiles] });
  f.searchHook(async () => { entered.resolve(); await resume.promise; });
  try {
    const pending = rejection(() => memory.execute('memory_search', { query: 'Decision' }, 'caller', new AbortController().signal));
    await entered.promise;
    memory.accounts(account('a'));
    resume.resolve();
    expect((await pending).message).toContain('cancel');
    await memory.synchronize();
    expect(memory.status().total).toBe(1);
    expect(f.grants.size).toBe(0);
  } finally { resume.resolve(); await memory.dispose(); await f.close(); }
});
