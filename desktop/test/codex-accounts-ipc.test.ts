import { expect, test } from 'bun:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CodexAccountsSnapshot, CodexAccountProfile } from '../shared/codex-accounts.ts';
import type { CodexAccountProfiles } from '../lib/codex-account-profiles.mts';
import { CodexAccountClients } from '../lib/codex-account-clients.mts';
import { registerCodexAccountsIpc } from '../lib/codex-accounts-ipc.mts';
import { accountUsageTotals } from '../shared/codex-account-usage.ts';
import type { WorkspaceAccountSelection } from '../lib/settings-service.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

function profile(id: string): CodexAccountProfile {
  return {
    id, label: id, email: null,
    usage: { state: 'ready', authenticated: true, plan: 'pro', rateLimits: [], error: null },
    login: { state: 'signed_in', error: null },
  };
}

function setup(accountSelection?: WorkspaceAccountSelection) {
  type Handler = Parameters<IpcMain['handle']>[1];
  const handlers = new Map<string, Handler>();
  const listeners = new Set<(snapshot: CodexAccountsSnapshot) => void>();
  const snapshot: CodexAccountsSnapshot = { activeId: 'default', profiles: [profile('default'), profile('second')] };
  const emitted: CodexAccountsSnapshot[] = [];
  let releases = 0;
  let resets = 0;
  let idleFailure: Error | null = null;
  let trusted = true;
  const profiles = {
    list: async () => snapshot,
    add: async () => snapshot,
    login: async (_id: string) => snapshot,
    logout: async (_id: string) => snapshot,
    cancelLogin: async (_id: string) => snapshot,
    cancelRegistration: async (_id: string) => snapshot,
    environment: async (id: string) => ({ CODEX_HOME: `/${id}` }),
    onDidChange(listener: (snapshot: CodexAccountsSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async release() { releases += 1; },
  };
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const options = {
    ipc: { handle(channel: string, handler: Handler) { handlers.set(channel, handler); } },
    // The injected service boundary supplies account snapshots without login or provider calls.
    profiles: profiles as unknown as CodexAccountProfiles,
    clients: pool, retained: [], accountSelection,
    assertSender(_event: IpcMainInvokeEvent) { if (!trusted) throw new Error('Untrusted sender'); },
    assertIdle() { if (idleFailure) throw idleFailure; },
    async exclusive<T>(operation: () => Promise<T>): Promise<T> { return await operation(); },
    async reset() { resets += 1; },
    emit(value: CodexAccountsSnapshot) { emitted.push(value); },
  };
  const registration = registerCodexAccountsIpc(options);
  const invoke = async (method: string, value?: unknown): Promise<CodexAccountsSnapshot> => {
    const handler = handlers.get(`cheshi:codex-accounts-${method}`);
    if (!handler) throw new Error('Missing test handler');
    return await handler({} as IpcMainInvokeEvent, value) as CodexAccountsSnapshot;
  };
  return {
    profiles, snapshot, pool, options, registration, invoke, emitted, listeners,
    setBusy(error: Error | null) { idleFailure = error; },
    setTrusted(value: boolean) { trusted = value; },
    get resets() { return resets; }, get releases() { return releases; },
  };
}

test('manual selection updates workspace selection and overlays later shared profile snapshots', async () => {
  const harness = setup();
  expect((await harness.invoke('select', 'second')).activeId).toBe('second');
  expect(harness.pool.environment.CODEX_HOME).toBe('/second');
  expect(harness.resets).toBe(1);
  for (const listener of harness.listeners) listener(harness.snapshot);
  expect(harness.emitted.at(-1)?.activeId).toBe('second');
  expect((await harness.invoke('list')).activeId).toBe('second');
  await harness.invoke('select', 'second');
  expect(harness.resets).toBe(1);
  expect((await harness.invoke('select', 'default')).activeId).toBe('default');
  expect(harness.pool.environment.CODEX_HOME).toBe('/default');
  await harness.registration.stop();
});

function setWeeklyUsage(profile: CodexAccountProfile, usedPercent: number): void {
  profile.usage.rateLimits = [{ limitId: 'codex', limitName: null, plan: 'pro', primary: null,
    secondary: { usedPercent, windowDurationMins: 10_080, resetsAt: null } }];
}

function failInitialization(error: unknown): never { throw error; }

test('a successful selection is restored into transports by a new workspace registration', async () => {
  let saved: string | null = null;
  const writes: string[] = [];
  const selection = { read: () => saved, write(id: string) { saved = id; writes.push(id); } };
  const first = setup(selection);
  try {
    await first.invoke('select', 'second');
    expect(selection.read()).toBe('second');
  } finally { await first.registration.stop(); }
  const reopened = setup(selection);
  try {
    expect((await reopened.registration.initialize(failInitialization))?.activeId).toBe('second');
    expect(reopened.pool.environment.CODEX_HOME).toBe('/second');
    expect(reopened.emitted.at(-1)?.activeId).toBe('second');
    expect(writes).toEqual(['second']);
  } finally { await reopened.registration.stop(); }
});

test('failed account changes do not overwrite selection and failed saves do not commit transports', async () => {
  let saved = 'default';
  let failSave = false;
  const harness = setup({ read: () => saved, write(id) {
    if (failSave) throw new Error('Could not save selection');
    saved = id;
  } });
  try {
    harness.setBusy(new Error('Busy'));
    await expectFailure(harness.invoke('select', 'second'), 'Busy');
    expect(saved).toBe('default');
    harness.setBusy(null);
    harness.options.reset = async () => { throw new Error('Reset failed'); };
    await expectFailure(harness.invoke('select', 'second'), 'Reset failed');
    expect(saved).toBe('default');
    harness.options.reset = async () => {};
    failSave = true;
    await expectFailure(harness.invoke('select', 'second'), 'Could not save');
    expect(harness.registration.activeId).toBe('default');
    expect(harness.pool.environment.CODEX_HOME).toBe('/default');
    expect(harness.emitted).toEqual([]);
    expect(saved).toBe('default');
    failSave = false;
    expect((await harness.invoke('select', 'second')).activeId).toBe('second');
    expect(saved).toBe('second');
  } finally { await harness.registration.stop(); }
});

test('startup falls back for missing or signed-out saved accounts without overwriting the preference', async () => {
  for (const saved of ['deleted', 'second']) {
    const writes: string[] = [];
    const harness = setup({ read: () => saved, write: id => { writes.push(id); } });
    harness.snapshot.profiles[1]!.usage.authenticated = false;
    try {
      expect((await harness.registration.initialize(failInitialization))?.activeId).toBe('default');
      expect(harness.pool.environment.CODEX_HOME).toBe('/default');
      expect(writes).toEqual([]);
    } finally { await harness.registration.stop(); }
  }
});

test('startup reports settings read failures and still opens with the default account', async () => {
  const failure = new Error('Could not read app settings');
  const errors: unknown[] = [];
  const harness = setup({ read() { throw failure; }, write() { throw new Error('Unexpected write'); } });
  try {
    expect((await harness.registration.initialize(error => errors.push(error)))?.activeId).toBe('default');
    expect(errors).toEqual([failure]);
    expect(harness.pool.environment.CODEX_HOME).toBe('/default');
  } finally { await harness.registration.stop(); }
});

test('restored account still follows quota fallback and stays selected when all accounts are exhausted', async () => {
  for (const defaultUsage of [20, 100]) {
    const harness = setup({ read: () => 'second', write() {} });
    setWeeklyUsage(harness.snapshot.profiles[0]!, defaultUsage);
    setWeeklyUsage(harness.snapshot.profiles[1]!, 100);
    try {
      const expected = defaultUsage === 100 ? 'second' : 'default';
      expect((await harness.registration.initialize(failInitialization))?.activeId).toBe(expected);
      expect(harness.pool.environment.CODEX_HOME).toBe(`/${expected}`);
    } finally { await harness.registration.stop(); }
  }
});

test('startup selects available usage and publishes the active percentage without a chat request', async () => {
  const harness = setup();
  setWeeklyUsage(harness.snapshot.profiles[0]!, 100);
  setWeeklyUsage(harness.snapshot.profiles[1]!, 23);
  try {
    const result = await harness.registration.initialize(failInitialization);
    expect(result?.activeId).toBe('second');
    expect(harness.pool.environment.CODEX_HOME).toBe('/second');
    expect(harness.resets).toBe(1);
    const published = harness.emitted.at(-1)!;
    expect(result).toEqual(published);
    expect(accountUsageTotals({ ...published,
      profiles: published.profiles.filter(profile => profile.id === published.activeId) })?.percent).toBe(77);
    for (const listener of harness.listeners) listener(harness.snapshot);
    expect(harness.emitted.at(-1)?.activeId).toBe('second');
    expect((await harness.invoke('list')).activeId).toBe('second');
  } finally { await harness.registration.stop(); }
});

test('startup publishes an available default account without changing transports', async () => {
  const harness = setup();
  setWeeklyUsage(harness.snapshot.profiles[0]!, 15);
  setWeeklyUsage(harness.snapshot.profiles[1]!, 0);
  try {
    expect((await harness.registration.initialize(failInitialization))?.activeId).toBe('default');
    expect(harness.emitted).toEqual([harness.snapshot]);
    expect(harness.pool.environment.CODEX_HOME).toBe('/default');
    expect(harness.resets).toBe(0);
  } finally { await harness.registration.stop(); }
});

test('startup keeps genuine zero usage when every account is exhausted', async () => {
  const harness = setup();
  for (const profile of harness.snapshot.profiles) setWeeklyUsage(profile, 100);
  try {
    expect((await harness.registration.initialize(failInitialization))?.activeId).toBe('default');
    expect(accountUsageTotals(harness.emitted.at(-1)!)?.remaining).toBe(0);
    expect(harness.resets).toBe(0);
  } finally { await harness.registration.stop(); }
});

test('startup never switches on unknown usage or to an account whose usage failed to load', async () => {
  for (const failedIndex of [0, 1]) {
    const harness = setup();
    setWeeklyUsage(harness.snapshot.profiles[0]!, 100);
    setWeeklyUsage(harness.snapshot.profiles[1]!, 0);
    harness.snapshot.profiles[failedIndex]!.usage.state = 'error';
    try {
      expect((await harness.registration.initialize(failInitialization))?.activeId).toBe('default');
      expect(harness.emitted).toEqual([harness.snapshot]);
      expect(harness.resets).toBe(0);
    } finally { await harness.registration.stop(); }
  }
});

test('startup lookup failure is reported without rejecting workspace startup and allows a later refresh', async () => {
  const harness = setup();
  const failure = new Error('Usage lookup failed');
  const errors: unknown[] = [];
  harness.profiles.list = async () => { throw failure; };
  try {
    expect(await harness.registration.initialize(error => errors.push(error))).toBeNull();
    expect(errors).toEqual([failure]);
    expect(harness.emitted).toEqual([]);
    expect(harness.registration.activeId).toBe('default');
    expect(harness.resets).toBe(0);
    harness.profiles.list = async () => harness.snapshot;
    expect((await harness.invoke('list')).activeId).toBe('default');
  } finally { await harness.registration.stop(); }
});

test('closing during startup lookup prevents a late account switch or publication', async () => {
  const harness = setup();
  const pending = createDeferred<CodexAccountsSnapshot>();
  harness.profiles.list = () => pending.promise;
  setWeeklyUsage(harness.snapshot.profiles[0]!, 100);
  setWeeklyUsage(harness.snapshot.profiles[1]!, 0);
  const initialization = harness.registration.initialize(failInitialization);
  await harness.registration.stop();
  pending.resolve(harness.snapshot);
  await expectFailure(initialization, 'workspace has closed');
  expect(harness.emitted).toEqual([]);
  expect(harness.resets).toBe(0);
});

test('registration cancellation validates the target and protects the active account', async () => {
  const harness = setup();
  const cancelled: string[] = [];
  harness.profiles.cancelRegistration = async id => { cancelled.push(id); return harness.snapshot; };
  await expectFailure(harness.invoke('cancel-registration', '../second'), 'Invalid account');
  await expectFailure(harness.invoke('cancel-registration', 'default'), 'active');
  await harness.invoke('cancel-registration', 'second');
  expect(cancelled).toEqual(['second']);
  await harness.registration.stop();
});

test('unknown, invalid, signed-out and failed-login targets leave current account unchanged', async () => {
  const harness = setup();
  await expectFailure(harness.invoke('select', 'absent'), 'not found');
  await expectFailure(harness.invoke('select', '../second'), 'Invalid account');
  const second = harness.snapshot.profiles[1]!;
  second.usage = { ...second.usage, state: 'login_required', authenticated: false };
  await expectFailure(harness.invoke('select', 'second'), 'Sign in');
  second.usage = { ...second.usage, state: 'error', error: 'Login failed' };
  second.login = { state: 'error', error: 'Login failed' };
  await expectFailure(harness.invoke('select', 'second'), 'Sign in');
  expect(harness.registration.activeId).toBe('default');
  expect(harness.pool.environment.CODEX_HOME).toBe('/default');
  expect(harness.resets).toBe(0);
  await harness.registration.stop();
});

test('busy guard and reset failures preserve selection and allow a later retry', async () => {
  const harness = setup();
  harness.setBusy(new Error('Chat response still running'));
  await expectFailure(harness.invoke('select', 'second'), 'still running');
  harness.setBusy(null);
  harness.options.reset = async () => { throw new Error('Context cleanup failed'); };
  await expectFailure(harness.invoke('select', 'second'), 'Context cleanup failed');
  expect(harness.registration.activeId).toBe('default');
  expect(harness.pool.environment.CODEX_HOME).toBe('/default');
  harness.options.reset = async () => {};
  expect((await harness.invoke('select', 'second')).activeId).toBe('second');
  await harness.registration.stop();
});

test('concurrent selection is rejected while account status is being checked', async () => {
  const harness = setup();
  const listed = createDeferred<CodexAccountsSnapshot>();
  harness.profiles.list = () => listed.promise;
  const selecting = harness.invoke('select', 'second');
  await expectFailure(harness.invoke('select', 'default'), 'already in progress');
  listed.resolve(harness.snapshot);
  expect((await selecting).activeId).toBe('second');
  await harness.registration.stop();
});

test('workspace close cancels a selection waiting for profile lookup', async () => {
  const harness = setup();
  const listed = createDeferred<CodexAccountsSnapshot>();
  harness.profiles.list = () => listed.promise;
  const selecting = harness.invoke('select', 'second');
  await harness.registration.stop();
  listed.resolve(harness.snapshot);
  await expectFailure(selecting, 'workspace has closed');
  await expectFailure(harness.invoke('list'), 'workspace has closed');
  expect(harness.registration.activeId).toBe('default');
  expect(harness.resets).toBe(0);
  expect(harness.listeners.size).toBe(0);
  expect(harness.releases).toBe(1);
});

test('workspace close while awaiting exclusive access cannot change account', async () => {
  const harness = setup();
  const waiting = createDeferred<void>();
  const release = createDeferred<void>();
  harness.options.exclusive = async operation => {
    waiting.resolve();
    await release.promise;
    return await operation();
  };
  const selecting = harness.invoke('select', 'second');
  await waiting.promise;
  await harness.registration.stop();
  release.resolve();
  await expectFailure(selecting, 'workspace has closed');
  expect(harness.pool.environment.CODEX_HOME).toBe('/default');
  expect(harness.resets).toBe(0);
});

test('untrusted senders cannot read or mutate account registrations', async () => {
  const harness = setup();
  harness.setTrusted(false);
  for (const method of ['list', 'add', 'login', 'logout', 'cancel-login', 'select']) {
    await expectFailure(harness.invoke(method, 'second'), 'Untrusted sender');
  }
  expect(harness.resets).toBe(0);
  await harness.registration.stop();
});

test('profile worker shutdown failure is surfaced on workspace close', async () => {
  const harness = setup();
  harness.profiles.release = async () => { throw new Error('Worker did not exit'); };
  await expectFailure(harness.registration.stop(), 'Worker did not exit');
  expect(harness.listeners.size).toBe(0);
  await expectFailure(harness.invoke('select', 'second'), 'workspace has closed');
});

test('active account login respects busy guards while a separate profile may sign in', async () => {
  const harness = setup();
  const attempted: string[] = [];
  harness.profiles.login = async id => { attempted.push(id); return harness.snapshot; };
  harness.setBusy(new Error('Chat response still running'));
  await expectFailure(harness.invoke('login', 'default'), 'still running');
  await harness.invoke('login', 'second');
  expect(attempted).toEqual(['second']);
  harness.setBusy(null);
  await harness.invoke('login', 'default');
  expect(attempted).toEqual(['second', 'default']);
  await harness.registration.stop();
});

function peerWorkspace(harness: ReturnType<typeof setup>) {
  type Handler = Parameters<IpcMain['handle']>[1];
  const handlers = new Map<string, Handler>();
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const registration = registerCodexAccountsIpc({
    ...harness.options, clients: pool,
    ipc: { handle(channel: string, handler: Handler) { handlers.set(channel, handler); } },
  });
  return {
    registration,
    async invoke(method: string, id: string): Promise<CodexAccountsSnapshot> {
      return await handlers.get(`cheshi:codex-accounts-${method}`)!({} as IpcMainInvokeEvent, id) as CodexAccountsSnapshot;
    },
  };
}

test('active logout stops transports before clearing credentials and resetting the workspace', async () => {
  const harness = setup();
  const order: string[] = [];
  const client = harness.pool.create({
    command: { executable: 'unused', args: [], environment: {} }, cwd: '/default',
    clientInfo: { name: 'account-test', title: 'Account test', version: '1' },
  });
  client.stop = async () => { order.push('stop'); harness.pool.clients.delete(client); };
  harness.profiles.logout = async id => {
    order.push(`logout:${id}`);
    expect(harness.pool.switching).toBe(true);
    return harness.snapshot;
  };
  harness.options.reset = async () => { order.push('reset'); };
  expect((await harness.invoke('logout', 'default')).activeId).toBe('default');
  expect(order).toEqual(['stop', 'logout:default', 'reset']);
  expect(harness.pool.generation).toBe(1);
  await harness.registration.stop();
});

test('inactive logout leaves workspace transports and conversations intact', async () => {
  const harness = setup();
  const attempts: string[] = [];
  harness.profiles.logout = async id => { attempts.push(id); return harness.snapshot; };
  harness.setBusy(new Error('Response running'));
  await harness.invoke('logout', 'second');
  expect(attempts).toEqual(['second']);
  expect(harness.resets).toBe(0);
  expect(harness.pool.generation).toBe(0);
  await harness.registration.stop();
});

test('active logout protects busy work and preserves contexts when the credential request fails', async () => {
  const harness = setup();
  let attempts = 0;
  harness.profiles.logout = async () => { attempts += 1; throw new Error('Logout timed out'); };
  harness.setBusy(new Error('Response running'));
  await expectFailure(harness.invoke('logout', 'default'), 'Response running');
  expect(attempts).toBe(0);
  harness.setBusy(null);
  await expectFailure(harness.invoke('logout', 'default'), 'Logout timed out');
  expect(harness.resets).toBe(0);
  expect(harness.pool.switching).toBe(false);
  expect(harness.pool.generation).toBe(0);
  harness.profiles.logout = async () => harness.snapshot;
  await harness.invoke('logout', 'default');
  expect(harness.resets).toBe(1);
  await harness.registration.stop();
});

test('another workspace active account cannot be logged out until that workspace closes', async () => {
  const harness = setup();
  const peer = peerWorkspace(harness);
  await peer.invoke('select', 'second');
  await expectFailure(harness.invoke('logout', 'second'), 'in use in another workspace');
  await peer.registration.stop();
  await harness.invoke('logout', 'second');
  await harness.registration.stop();
});

test('selection reserves its target before asynchronous lookup and blocks logout in other windows', async () => {
  const harness = setup();
  const peer = peerWorkspace(harness);
  const listed = createDeferred<CodexAccountsSnapshot>();
  harness.profiles.list = () => listed.promise;
  const selecting = peer.invoke('select', 'second');
  await expectFailure(harness.invoke('logout', 'second'), 'in use in another workspace');
  listed.resolve(harness.snapshot);
  await selecting;
  await peer.registration.stop();
  await harness.registration.stop();
});

test('logout reserves its target until completion and rejects selection or login from another window', async () => {
  const harness = setup();
  const peer = peerWorkspace(harness);
  const loggedOut = createDeferred<CodexAccountsSnapshot>();
  harness.profiles.logout = () => loggedOut.promise;
  const loggingOut = harness.invoke('logout', 'second');
  await expectFailure(peer.invoke('select', 'second'), 'being logged out');
  await expectFailure(peer.invoke('login', 'second'), 'being logged out');
  await expectFailure(harness.invoke('select', 'default'), 'already in progress');
  loggedOut.resolve(harness.snapshot);
  await loggingOut;
  await peer.invoke('select', 'second');
  await peer.registration.stop();
  await harness.registration.stop();
});

test('closing while logout waits for exclusive access prevents credential removal', async () => {
  const harness = setup();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let attempts = 0;
  harness.profiles.logout = async () => { attempts += 1; return harness.snapshot; };
  harness.options.exclusive = async operation => { entered.resolve(); await release.promise; return operation(); };
  const loggingOut = harness.invoke('logout', 'default');
  await entered.promise;
  await harness.registration.stop();
  release.resolve();
  await expectFailure(loggingOut, 'workspace has closed');
  expect(attempts).toBe(0);
});

test('a new workspace cannot acquire the default account while it is being logged out', async () => {
  const harness = setup();
  const entered = createDeferred<void>();
  const finished = createDeferred<CodexAccountsSnapshot>();
  harness.profiles.logout = async () => { entered.resolve(); return finished.promise; };
  const loggingOut = harness.invoke('logout', 'default');
  await entered.promise;
  expect(() => peerWorkspace(harness)).toThrow('default account is being logged out');
  finished.resolve(harness.snapshot);
  await loggingOut;
  const peer = peerWorkspace(harness);
  await peer.registration.stop();
  await harness.registration.stop();
});
