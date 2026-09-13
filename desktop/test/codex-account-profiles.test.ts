import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAccountProfiles, getCodexAccountProfiles } from '../lib/codex-account-profiles.mts';
import type { CodexAccountsSnapshot } from '../shared/codex-accounts.ts';

type JsonObject = Record<string, unknown>;

class FakeClient {
  account: unknown = { account: null };
  usedPercent = 15;
  stops = 0;
  logoutError: Error | null = null;
  calls: { method: string; params: unknown }[] = [];
  notifications = new Set<(value: JsonObject) => void>();
  failures = new Set<(error: Error) => void>();
  async start(): Promise<JsonObject> { return {}; }
  async stop(): Promise<void> { this.stops += 1; }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'account/read') return this.account;
    if (method === 'account/logout') {
      if (this.logoutError) throw this.logoutError;
      this.account = { account: null };
      this.emit('account/updated', { authMode: null, planType: null });
      return {};
    }
    if (method === 'account/login/start') {
      return { type: 'chatgpt', loginId: 'owned-login', authUrl: 'https://auth.openai.com/authorize?state=opaque' };
    }
    if (method === 'account/rateLimits/read') {
      return { rateLimits: { limitId: 'codex', primary: {
        usedPercent: this.usedPercent, windowDurationMins: 10080, resetsAt: 1800000000,
      } } };
    }
    return {};
  }
  onNotification(listener: (value: JsonObject) => void): () => void {
    this.notifications.add(listener);
    return () => { this.notifications.delete(listener); };
  }
  onDidFail(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => { this.failures.delete(listener); };
  }
  emit(method: string, params: unknown): void {
    for (const listener of this.notifications) listener({ method, params });
  }
}

async function fixture(options: { loginTimeoutMs?: number; singleton?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-account-profiles-'));
  const directory = join(root, 'profiles');
  const defaultHome = join(root, 'existing-codex');
  await mkdir(defaultHome);
  const opened: string[] = [];
  const clients: FakeClient[] = [];
  const environments: Record<string, string | undefined>[] = [];
  const profileOptions = {
    directory, defaultHome, cwd: root, loginTimeoutMs: options.loginTimeoutMs,
    openExternal: async (url: string) => { opened.push(url); },
    createClient: (environment: Record<string, string | undefined>) => {
      environments.push(environment);
      const client = new FakeClient();
      if (environment.CODEX_HOME === defaultHome) {
        client.account = { account: { type: 'chatgpt', email: 'first@example.test', planType: 'pro' } };
      }
      clients.push(client);
      return client;
    },
  };
  const service = options.singleton ? getCodexAccountProfiles(profileOptions) : new CodexAccountProfiles(profileOptions);
  return {
    root, directory, defaultHome, service, clients, environments, opened, profileOptions,
    async cleanup() { await service.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

function addedId(snapshot: CodexAccountsSnapshot): string {
  const id = snapshot.profiles.at(-1)?.id;
  assert.ok(id && id !== 'default');
  return id;
}

test('logout clears identity and usage while retaining the profile and conversation files', async () => {
  const f = await fixture();
  try {
    const id = addedId(await f.service.add());
    f.clients[1]!.account = { account: { type: 'chatgpt', email: 'second@example.test', planType: 'pro' } };
    await f.service.list();
    const environment = await f.service.environment(id);
    const history = join(environment.CODEX_HOME!, 'history.jsonl');
    await writeFile(history, 'retained conversation');
    const snapshot = await f.service.logout(id);
    const loggedOut = snapshot.profiles.find(profile => profile.id === id)!;
    assert.equal(loggedOut.email, null);
    assert.equal(loggedOut.login.state, 'signed_out');
    assert.deepEqual(loggedOut.usage, {
      state: 'login_required', authenticated: false, plan: null, rateLimits: [], error: null,
    });
    assert.equal(snapshot.profiles[0]?.usage.authenticated, true);
    assert.equal(await readFile(history, 'utf8'), 'retained conversation');
    const saved = JSON.parse(await readFile(join(f.directory, 'profiles.json'), 'utf8'));
    assert.equal(saved.profiles[0].id, id);
    assert.equal(f.clients[0]!.calls.some(call => call.method === 'account/logout'), false);
    assert.equal((await f.service.login(id)).profiles[1]?.login.state, 'signing_in');
  } finally { await f.cleanup(); }
});

test('logout failure preserves authenticated status and supports retry', async () => {
  const f = await fixture();
  try {
    await f.service.list();
    f.clients[0]!.logoutError = new Error('Logout request timed out');
    await expectFailure(f.service.logout('default'), /timed out/);
    assert.equal((await f.service.list()).profiles[0]?.usage.authenticated, true);
    f.clients[0]!.logoutError = null;
    assert.equal((await f.service.logout('default')).profiles[0]?.usage.authenticated, false);
    await expectFailure(f.service.logout('absent'), /Unknown Codex account/);
  } finally { await f.cleanup(); }
});

test('logout cancels an outstanding browser login before removing credentials', async () => {
  const f = await fixture();
  try {
    const id = addedId(await f.service.add());
    await f.service.login(id);
    const snapshot = await f.service.logout(id);
    const methods = f.clients[1]!.calls.map(call => call.method);
    assert.ok(methods.indexOf('account/login/cancel') < methods.indexOf('account/logout'));
    assert.equal(snapshot.profiles[1]?.login.state, 'signed_out');
  } finally { await f.cleanup(); }
});

test('cancelling an unsigned registration removes the saved entry and stops only its worker', async () => {
  const f = await fixture();
  try {
    const id = addedId(await f.service.add());
    const cancelled = await f.service.cancelRegistration(id);
    assert.deepEqual(cancelled.profiles.map(profile => profile.id), ['default']);
    const saved = JSON.parse(await readFile(join(f.directory, 'profiles.json'), 'utf8'));
    assert.deepEqual(saved.profiles, []);
    assert.equal(f.clients[1]?.stops, 1);
    assert.equal(f.clients[0]?.stops, 0);
    assert.equal(f.clients.some(client => client.calls.some(call => call.method === 'account/logout')), false);
    await expectFailure(f.service.environment(id), /Unknown Codex account/);
    await expectFailure(f.service.cancelRegistration('default'), /default account cannot/);
  } finally { await f.cleanup(); }
});

test('cancelling registration ends a pending browser login but preserves an account that completed login', async () => {
  const f = await fixture();
  try {
    const id = addedId(await f.service.add());
    await f.service.login(id);
    await f.service.cancelRegistration(id);
    assert.ok(f.clients[1]?.calls.some(call => call.method === 'account/login/cancel'));
    assert.equal(f.clients[1]?.notifications.size, 0);

    const signedId = addedId(await f.service.add());
    const signedClient = f.clients[2]!;
    await f.service.login(signedId);
    signedClient.account = { account: { type: 'chatgpt', email: 'second@example.test', planType: 'pro' } };
    await expectFailure(f.service.cancelRegistration(signedId), /has signed in/);
    assert.ok((await f.service.list()).profiles.some(profile => profile.id === signedId && profile.usage.authenticated));
    assert.equal(signedClient.stops, 0);
  } finally { await f.cleanup(); }
});

test('adding after cancellation keeps account labels unique', async () => {
  const f = await fixture();
  try {
    const second = addedId(await f.service.add());
    await f.service.add();
    await f.service.cancelRegistration(second);
    const snapshot = await f.service.add();
    assert.equal(new Set(snapshot.profiles.map(profile => profile.label)).size, snapshot.profiles.length);
  } finally { await f.cleanup(); }
});

async function expectFailure(operation: Promise<unknown>, message: RegExp): Promise<void> {
  try { await operation; }
  catch (error) { assert.match(String(error), message); return; }
  assert.fail('Expected failure.');
}

test('existing account stays in its original home and listing never reads authentication files', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.defaultHome, 'auth.json'), 'synthetic unreadable auth format');
    assert.equal(f.clients.length, 0);
    const snapshot = await f.service.list();
    assert.equal(snapshot.activeId, 'default');
    assert.equal(snapshot.profiles[0]?.email, 'first@example.test');
    assert.equal(snapshot.profiles[0]?.usage.plan, 'pro');
    assert.equal(snapshot.profiles[0]?.login.state, 'signed_in');
    assert.deepEqual(await f.service.environment('default'), { CODEX_HOME: f.defaultHome });
    assert.equal(await readFile(join(f.defaultHome, 'auth.json'), 'utf8'), 'synthetic unreadable auth format');
    assert.ok(f.clients[0]?.calls.every(({ method }) => ['account/read', 'account/rateLimits/read'].includes(method)));
  } finally { await f.cleanup(); }
});

test('concurrent additions persist distinct nonsecret profiles and private isolated homes', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.service.add(), f.service.add()]);
    const snapshot = await f.service.list();
    assert.deepEqual(snapshot.profiles.map((profile) => profile.label), ['Default account', 'Account 2', 'Account 3']);
    const saved = JSON.parse(await readFile(join(f.directory, 'profiles.json'), 'utf8')) as JsonObject;
    assert.deepEqual(saved, {
      version: 1,
      profiles: snapshot.profiles.slice(1).map(({ id, label }) => ({ id, label })),
    });
    for (const profile of snapshot.profiles.slice(1)) {
      const environment = await f.service.environment(profile.id);
      assert.equal(environment.CODEX_HOME, join(f.directory, profile.id));
      for (const name of ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_SQLITE_HOME']) {
        assert.equal(Object.hasOwn(environment, name), true);
        assert.equal(environment[name], undefined);
      }
      assert.equal(await readFile(join(environment.CODEX_HOME!, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
      assert.equal((await stat(environment.CODEX_HOME!)).mode & 0o777, 0o700);
      assert.equal((await stat(join(environment.CODEX_HOME!, 'config.toml'))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(join(f.directory, 'profiles.json'))).mode & 0o777, 0o600);
    assert.equal(snapshot.profiles[1]?.login.state, 'signed_out');
    assert.deepEqual(f.opened, []);
  } finally { await f.cleanup(); }
});

test('managed login completion updates the matching account usage without logging out another account', async () => {
  const f = await fixture();
  try {
    const id = addedId(await f.service.add());
    const events: CodexAccountsSnapshot[] = [];
    f.service.onDidChange((snapshot) => events.push(snapshot));
    assert.equal((await f.service.login(id)).profiles[1]?.login.state, 'signing_in');
    assert.equal(f.opened.length, 1);
    const second = f.clients[1]!;
    second.account = { account: { type: 'chatgpt', email: 'second@example.test', planType: 'pro' } };
    second.usedPercent = 91;
    second.emit('account/login/completed', { loginId: 'owned-login', success: true });
    await delay(0);
    const snapshot = await f.service.list();
    assert.equal(snapshot.profiles[1]?.email, 'second@example.test');
    assert.equal(snapshot.profiles[1]?.login.state, 'signed_in');
    assert.equal(snapshot.profiles[1]?.usage.rateLimits[0]?.primary?.usedPercent, 91);
    assert.equal(snapshot.profiles[0]?.usage.rateLimits[0]?.primary?.usedPercent, 15);
    assert.ok(events.some((event) => event.profiles[1]?.email === 'second@example.test'));
    assert.ok(f.clients.every((client) => client.calls.every(({ method }) => !method.includes('logout') && !method.startsWith('thread/'))));
  } finally { await f.cleanup(); }
});

test('login attempts across profiles are serialized until cancellation', async () => {
  const f = await fixture();
  try {
    const first = addedId(await f.service.add());
    const second = addedId(await f.service.add());
    await f.service.login(first);
    await expectFailure(f.service.login(second), /Finish or cancel/u);
    assert.equal((await f.service.cancelLogin(first)).profiles[1]?.login.state, 'signed_out');
    assert.equal((await f.service.login(second)).profiles[2]?.login.state, 'signing_in');
    assert.equal(f.opened.length, 2);
    assert.ok(f.clients[1]?.calls.some(({ method }) => method === 'account/login/cancel'));
  } finally { await f.cleanup(); }
});

test('login timeout remains an error and closing releases every observer and process', async () => {
  const f = await fixture({ loginTimeoutMs: 5 });
  try {
    const id = addedId(await f.service.add());
    await f.service.login(id);
    await delay(20);
    const snapshot = await f.service.list();
    assert.equal(snapshot.profiles[1]?.login.state, 'error');
    assert.match(snapshot.profiles[1]?.login.error ?? '', /timed out/u);
    await f.service.dispose();
    await f.service.dispose();
    for (const client of f.clients) {
      assert.equal(client.stops, 1);
      assert.equal(client.notifications.size, 0);
      assert.equal(client.failures.size, 0);
    }
    await expectFailure(f.service.list(), /closed/u);
  } finally { await f.cleanup(); }
});

test('profiles survive reload without persisting email or account usage', async () => {
  const f = await fixture();
  let reopened: CodexAccountProfiles | undefined;
  try {
    const initial = await f.service.add();
    await f.service.dispose();
    reopened = new CodexAccountProfiles(f.profileOptions);
    const snapshot = await reopened.list();
    assert.deepEqual(snapshot.profiles.map(({ id, label }) => ({ id, label })), initial.profiles.map(({ id, label }) => ({ id, label })));
    assert.equal(snapshot.profiles[1]?.email, null);
    assert.equal(snapshot.profiles[1]?.login.state, 'signed_out');
  } finally { await reopened?.dispose(); await f.cleanup(); }
});

test('unknown and path traversal profile IDs never resolve to a process environment', async () => {
  const f = await fixture();
  try {
    for (const id of ['../outside', '/tmp', 'unknown', '']) {
      await expectFailure(f.service.environment(id), /Unknown Codex account/u);
      await expectFailure(f.service.login(id), /Unknown Codex account/u);
    }
    assert.equal(f.clients.length, 1);
  } finally { await f.cleanup(); }
});

test('malformed registry IDs cannot redirect account storage', async () => {
  const f = await fixture();
  try {
    await mkdir(f.directory);
    await writeFile(join(f.directory, 'profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: '../escape', label: 'Account' }] }));
    await expectFailure(f.service.list(), /Invalid saved Codex account profile/u);
    assert.equal(f.clients.length, 0);
  } finally { await f.cleanup(); }
});

test('shared registry remains alive until the last workspace releases it', async () => {
  const f = await fixture({ singleton: true });
  try {
    const second = getCodexAccountProfiles(f.profileOptions);
    assert.equal(second, f.service);
    await f.service.list();
    await f.service.release();
    assert.equal(f.clients[0]?.stops, 0);
    await second.list();
    await second.release();
    assert.equal(f.clients[0]?.stops, 1);
    const next = getCodexAccountProfiles(f.profileOptions);
    assert.notEqual(next, f.service);
    await next.release();
  } finally { await f.cleanup(); }
});

test('profile count is bounded before any extra account process is created', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 9; index += 1) await f.service.add();
    await expectFailure(f.service.add(), /Up to 10/u);
    assert.equal(f.clients.length, 10);
  } finally { await f.cleanup(); }
});

test('default profile clients negotiate experimental history and goal capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-profile-capabilities-'));
  const executable = join(root, 'history-server.mts');
  const previousExecutable = process.env.CHESHI_CODEX;
  let service: CodexAccountProfiles | undefined;
  try {
    await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
let experimentalApi = false;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  let error;
  if (request.method === 'initialize') {
    experimentalApi = request.params?.capabilities?.experimentalApi === true;
    result = {};
  } else if (request.method === 'account/read') {
    result = { account: null };
  } else if (request.method === 'account/rateLimits/read') {
    result = { rateLimits: null };
  } else if (request.method === 'thread/list' || request.method === 'thread/goal/get') {
    if (!experimentalApi) {
      error = { code: -32600, message: 'History request requires experimentalApi capability' };
    } else {
      result = { method: request.method, params: request.params, experimentalApi };
    }
  } else {
    error = { code: -32601, message: 'Unexpected method: ' + request.method };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\\n');
}
`, { mode: 0o700 });
    process.env.CHESHI_CODEX = executable;
    service = new CodexAccountProfiles({
      directory: join(root, 'profiles'), defaultHome: join(root, 'default'), cwd: root,
      openExternal: async () => { assert.fail('History lookup must not start browser login.'); },
    });
    const managedId = addedId(await service.add());
    for (const profileId of ['default', managedId]) {
      const listParams = { ancestorThreadId: 'root-thread', cursor: null };
      assert.deepEqual(await service.historyRequest(profileId, 'thread/list', listParams), {
        method: 'thread/list', params: listParams, experimentalApi: true,
      });
      const goalParams = { threadId: 'child-thread' };
      assert.deepEqual(await service.historyRequest(profileId, 'thread/goal/get', goalParams), {
        method: 'thread/goal/get', params: goalParams, experimentalApi: true,
      });
    }
  } finally {
    if (previousExecutable === undefined) delete process.env.CHESHI_CODEX;
    else process.env.CHESHI_CODEX = previousExecutable;
    await service?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
