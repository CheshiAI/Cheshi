import { expect, test } from 'bun:test';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { sessionDocuments } from '../lib/flash/sources.mts';
import { searchSessions } from '../lib/chat-search-source.mts';
import { account, deferred, flashFixture, history, rejection, session } from './flash-test-helpers.ts';

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

test('source revisions reconcile updates, deletion and restart without reembedding unchanged messages', async () => {
  const f = await flashFixture();
  let sessions = [session(), session('other', 'b')];
  let raw = history();
  const options = { workspace: '/workspace', host: f.host, source: { list: async () => ({ sessions }), read: async () => raw } };
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
      const read = await restarted.execute('memory_read', { source_id: result.matches[0]!.source_id }, 'current', signal) as { source: { text: string } };
      expect(read.source.text).toBe('Changed source');
      sessions = [];
      restarted.changed({ type: 'sessions-deleted', threadIds: ['s'] });
      const removed = await restarted.execute('memory_search', { query: 'memory' }, 'current', signal);
      expect(removed).toEqual({ matches: [] });
      expect(f.methods).toContain('sessions.delete');
    } finally { await restarted.dispose(); }
  } finally { await first.dispose(); await f.close(); }
});

test('account switching cancels old results and never uses another profile source', async () => {
  const f = await flashFixture();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
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
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions: [session()] }), read: async () => raw } });
  memory.accounts(account());
  f.searchHook(async () => { raw = history('Changed while searching'); });
  try {
    const error = await rejection(() => memory.execute('memory_search', { query: 'q' }, 'current', new AbortController().signal));
    expect(error.message).toContain('Source changed');
    expect(f.grants.size).toBe(0);
  } finally { await memory.dispose(); await f.close(); }
});
