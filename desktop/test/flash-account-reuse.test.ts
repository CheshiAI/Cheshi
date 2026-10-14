import { expect, test } from 'bun:test';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { chooseCodexAccount } from '../lib/codex-account-availability.mts';
import { account, deferred, flashFixture, history, rejection, session } from './flash-test-helpers.ts';

const both = (activeId = 'a') => ({ activeId, profiles: [...account('a').profiles, ...account('b').profiles] });
const disconnected = (id: string) => ({ ...account(id, false).profiles[0]!, email: null });
const signal = () => new AbortController().signal;

test('a signed-out startup does not launch Flash or read session history', async () => {
  let transactions = 0, lists = 0;
  const memory = new FlashSessionMemory({ workspace: '/workspace',
    host: { transaction: async () => { transactions++; throw new Error('Unexpected Flash startup'); }, release: async () => {} },
    source: { list: async () => { lists++; return { sessions: [] }; }, read: async () => history() } });
  try {
    memory.accounts({ activeId: 'a', profiles: [disconnected('a')] });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(memory.status().state).toBe('signed_out');
    expect(transactions).toBe(0);
    expect(lists).toBe(0);
  } finally { await memory.dispose(); }
});

test('manual and automatic selection keep a ready index without a catalog sync', async () => {
  const f = await flashFixture();
  let lists = 0;
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => { lists++; return { sessions: [session()] }; }, read: async () => history() } });
  memory.accounts(both());
  try {
    await memory.synchronize();
    const ready = memory.status();
    memory.accounts(both('b'));
    expect(memory.status()).toEqual(ready);
    const snapshot = both('b');
    snapshot.profiles[0]!.usage.rateLimits = [{ limitId: 'codex', limitName: null, plan: null,
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, secondary: null }];
    snapshot.profiles[1]!.usage.rateLimits = [{ limitId: 'codex', limitName: null, plan: null,
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 }, secondary: null }];
    const selected = chooseCodexAccount(snapshot);
    expect(selected.accountId).toBe('a');
    memory.accounts({ ...snapshot, activeId: selected.accountId! });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(memory.status()).toEqual(ready);
    expect(lists).toBe(1);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(1);
    expect(f.methods.filter(method => method === 'sources.list')).toHaveLength(1);
  } finally { await memory.dispose(); await f.close(); }
});

test('selection cancels the old search while retaining an in-flight shared synchronization', async () => {
  const f = await flashFixture();
  const entered = deferred<void>(), resume = deferred<void>();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => { entered.resolve(); await resume.promise; return { sessions: [session()] }; }, read: async () => history() } });
  memory.accounts(both());
  try {
    const sync = memory.synchronize();
    const pending = rejection(() => memory.execute('memory_search', { query: 'q' }, 'caller', signal()));
    await entered.promise;
    memory.accounts(both('b'));
    expect(memory.synchronize()).toBe(sync);
    expect((await pending).name).toBe('AbortError');
    resume.resolve(); await sync;
    expect(memory.status().state).toBe('ready');
    expect(f.methods.filter(method => method === 'sources.list')).toHaveLength(1);
    expect(await memory.execute('memory_search', { query: 'q' }, 'caller', signal())).toMatchObject({ matches: [{ session_id: 's' }] });
  } finally { resume.resolve(); await memory.dispose(); await f.close(); }
});

test('logout hides sources and relogin after restart reuses unchanged sources', async () => {
  const f = await flashFixture();
  let edited = false;
  const options = { workspace: '/workspace', host: f.host, source: {
    list: async () => ({ sessions: [session('a-session', 'a'), session('b-session', 'b')] }),
    read: async (id: string) => history(id === 'b-session' && edited ? 'Changed decision' : `Decision ${id}`, id),
  } };
  let memory = new FlashSessionMemory(options);
  memory.accounts(both());
  try {
    await memory.synchronize();
    memory.accounts({ activeId: 'a', profiles: [...account('a').profiles, disconnected('b')] });
    await memory.synchronize();
    const result = await memory.execute('memory_search', { query: 'q' }, 'caller', signal()) as { matches: { session_id: string }[] };
    expect(result.matches.map(item => item.session_id)).toEqual(['a-session']);
    expect([...f.stored.values()][0]!.size).toBe(2);
    expect(f.methods).not.toContain('source.delete');
    await memory.dispose();
    memory = new FlashSessionMemory(options);
    memory.accounts(both()); await memory.synchronize();
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    expect(memory.status().total).toBe(2);
    edited = true;
    memory.changed({ type: 'turn-completed' }); await memory.synchronize();
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(3);
  } finally { await memory.dispose(); await f.close(); }
});

test('all signed-out sources remain stored but unavailable, and explicit deletion still removes them', async () => {
  const f = await flashFixture();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions: [session()] }), read: async () => history() } });
  memory.accounts(account());
  try {
    await memory.synchronize();
    memory.accounts({ activeId: 'a', profiles: [disconnected('a')] });
    expect((await rejection(() => memory.execute('memory_search', { query: 'q' }, 'caller', signal()))).message).toContain('Sign in');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const sources = [...f.stored.values()][0]!;
    expect([...sources.values()]).toHaveLength(1);
    expect([...sources.values()][0]!.active).toBe(false);
    memory.accounts(account()); await memory.synchronize();
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(1);
    memory.accounts({ activeId: 'a', profiles: [disconnected('a')] });
    await memory.remove(['s']);
    expect(sources.size).toBe(0);
  } finally { await memory.dispose(); await f.close(); }
});

test('a different login identity and removed profiles cannot inherit unavailable sources', async () => {
  const f = await flashFixture();
  let sessions = [session('a-session', 'a'), session('b-session', 'b')];
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions }), read: async id => history(`Decision ${id}`, id) } });
  memory.accounts(both());
  try {
    await memory.synchronize();
    sessions = [];
    const replacement = account('a');
    replacement.profiles[0]!.email = 'replacement@example.com';
    memory.accounts(replacement); await memory.synchronize();
    expect([...f.stored.values()][0]!.size).toBe(0);
    expect(f.methods.filter(method => method === 'source.delete')).toHaveLength(2);
    expect(await memory.execute('memory_search', { query: 'q' }, 'caller', signal())).toEqual({ matches: [] });
  } finally { await memory.dispose(); await f.close(); }
});

test('deleting a session outside the app is reconciled when its account reconnects', async () => {
  const f = await flashFixture();
  let sessions = [session('a-session', 'a'), session('b-session', 'b')];
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions }), read: async id => history(`Decision ${id}`, id) } });
  memory.accounts(both());
  try {
    await memory.synchronize();
    memory.accounts({ activeId: 'a', profiles: [...account('a').profiles, disconnected('b')] });
    await memory.synchronize();
    sessions = [session('a-session', 'a')];
    memory.accounts(both()); await memory.synchronize();
    expect([...f.stored.values()][0]!.size).toBe(1);
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    expect(f.methods.filter(method => method === 'source.delete')).toHaveLength(1);
  } finally { await memory.dispose(); await f.close(); }
});

test('legacy sources gain ownership without reingestion and remain hidden while their account is absent', async () => {
  const f = await flashFixture();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions: [session('a-session', 'a'), session('b-session', 'b')] }),
      read: async id => history(`Decision ${id}`, id) } });
  memory.accounts(both());
  try {
    await memory.synchronize();
    for (const source of [...f.stored.values()][0]!.values()) { delete source.owner; delete source.active; }
    memory.accounts({ activeId: 'a', profiles: [...account('a').profiles, disconnected('b')] });
    await memory.synchronize();
    await memory.synchronize();
    expect([...f.stored.values()][0]!.size).toBe(2);
    expect(f.methods).not.toContain('source.delete');
    memory.accounts(both()); await memory.synchronize();
    expect(f.methods.filter(method => method === 'source.ingest')).toHaveLength(2);
    expect([...[...f.stored.values()][0]!.values()].every(source => source.active === true && source.owner !== 'legacy:unknown')).toBe(true);
  } finally { await memory.dispose(); await f.close(); }
});
