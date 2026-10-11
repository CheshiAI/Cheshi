import { expect, test } from 'bun:test';
import { HomieCatalog, type HomieAccountsApi } from '../frontend/src/features/agents/homieCatalog';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts';
import { registryDeferred, specialistModels } from './agent-registry-fixtures';

function accountSnapshot(email = 'one@example.test', authenticated = true): CodexAccountsSnapshot {
  return { activeId: 'default', profiles: [{ id: 'default', label: 'Default account', email,
    login: { state: authenticated ? 'signed_in' : 'signed_out', error: null },
    usage: { state: authenticated ? 'ready' : 'login_required', authenticated, plan: null, rateLimits: [], error: null } }] };
}
function accountsFixture() {
  let calls = 0;
  let receive: (snapshot: CodexAccountsSnapshot) => void = () => {};
  const pending = registryDeferred<CodexAccountsSnapshot>();
  const api: HomieAccountsApi = { list: () => { calls++; return pending.promise; },
    onDidChange: listener => { receive = listener; return () => { receive = () => {}; }; } };
  return { api, pending, calls: () => calls, emit: (snapshot: CodexAccountsSnapshot) => receive(snapshot) };
}
async function failure(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (value) { error = value; }
  expect(String(error)).toContain(message);
}

test('Homie catalogs reuse completed and pending requests and retain data during expired refreshes', async () => {
  let calls = 0, now = 0;
  let pending = registryDeferred<ReturnType<typeof specialistModels>>();
  const store = new HomieCatalog(() => { calls++; return pending.promise; }, () => now);
  try {
    const first = store.loadModels('default'), second = store.loadModels('default');
    expect(first).toBe(second);
    await Promise.resolve(); expect(calls).toBe(1);
    pending.resolve(specialistModels()); await first;
    expect(await store.loadModels('default')).toEqual(specialistModels()); expect(calls).toBe(1);
    const previous = store.modelSnapshot('default').models;
    now = 61_000; pending = registryDeferred();
    const refresh = store.loadModels('default');
    expect(store.modelSnapshot('default')).toMatchObject({ models: previous, loading: false, refreshing: true });
    pending.resolve([specialistModels()[1]!]); await refresh;
    expect(calls).toBe(2);
    expect(store.modelSnapshot('default').models).toHaveLength(1);
  } finally { store.dispose(); }
});

test('accounts load once across editors and newer notifications win over a slow list response', async () => {
  const f = accountsFixture(), store = new HomieCatalog(async () => specialistModels());
  try {
    store.connectAccounts(f.api);
    const first = store.ensureAccounts(), second = store.ensureAccounts();
    await Promise.resolve(); expect(f.calls()).toBe(1);
    f.emit(accountSnapshot('new@example.test'));
    f.pending.resolve(accountSnapshot('old@example.test')); await Promise.all([first, second]);
    store.connectAccounts(f.api); await store.ensureAccounts();
    expect(f.calls()).toBe(1);
    expect(store.accountsSnapshot().profiles[0]?.email).toBe('new@example.test');
  } finally { store.dispose(); }
});

test('authentication changes invalidate model results while routine account notifications keep them cached', async () => {
  const f = accountsFixture();
  let calls = 0;
  const old = registryDeferred<ReturnType<typeof specialistModels>>();
  const store = new HomieCatalog(async () => { calls++; return calls === 1 ? old.promise : [specialistModels()[1]!]; });
  try {
    store.connectAccounts(f.api); f.emit(accountSnapshot());
    const first = store.loadModels('default'); await Promise.resolve();
    f.emit(accountSnapshot('one@example.test', false));
    old.resolve(specialistModels()); await first;
    expect(store.modelSnapshot('default').models).toEqual([]);
    await failure(store.loadModels('default'), 'Sign in');
    f.emit(accountSnapshot('two@example.test'));
    expect(await store.loadModels('default')).toEqual([specialistModels()[1]!]);
    const cached = store.modelSnapshot('default');
    f.emit(accountSnapshot('two@example.test'));
    expect(store.modelSnapshot('default')).toBe(cached);
    await store.loadModels('default'); expect(calls).toBe(2);
    f.emit({ activeId: '', profiles: [] });
    await failure(store.loadModels('default'), 'unavailable');
    expect(store.modelSnapshot('default').models).toEqual([]);
  } finally { store.dispose(); }
});

test('a failed background refresh keeps cached options and explicit retry can recover', async () => {
  let fail = false, now = 0;
  const store = new HomieCatalog(async () => { if (fail) throw Error('Offline'); return specialistModels(); }, () => now);
  try {
    await store.loadModels('default'); fail = true; now = 61_000;
    await failure(store.loadModels('default'), 'Offline');
    expect(store.modelSnapshot('default')).toMatchObject({ models: specialistModels(), loading: false, error: 'Offline' });
    fail = false; await store.loadModels('default', true);
    expect(store.modelSnapshot('default').error).toBeNull();
  } finally { store.dispose(); }
});
