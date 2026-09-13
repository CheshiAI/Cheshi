import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceCodexLoginService } from '../lib/workspace-codex-login.mts';

type JsonObject = Record<string, unknown>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

class FakeClient {
  calls: { method: string; params: unknown }[] = [];
  starts = 0;
  stops = 0;
  account: unknown = { account: null };
  login: unknown = { type: 'chatgpt', loginId: 'owned-login', authUrl: 'https://auth.openai.com/authorize?state=private' };
  override: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  notifications = new Set<(value: JsonObject) => void>();
  failures = new Set<(error: Error) => void>();
  async start(): Promise<JsonObject> { this.starts += 1; return {}; }
  async stop(): Promise<void> { this.stops += 1; }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.override) return await this.override(method, params);
    return method === 'account/read' ? this.account : method === 'account/login/start' ? this.login : {};
  }
  onNotification(listener: (value: JsonObject) => void) {
    this.notifications.add(listener);
    return () => { this.notifications.delete(listener); };
  }
  onDidFail(listener: (error: Error) => void) {
    this.failures.add(listener);
    return () => { this.failures.delete(listener); };
  }
  emit(method: string, params: unknown): void {
    for (const listener of this.notifications) listener({ method, params });
  }
}

function fixture(options: { loginTimeoutMs?: number; failBrowser?: boolean } = {}) {
  const client = new FakeClient();
  const opened: string[] = [];
  const service = new WorkspaceCodexLoginService({
    client,
    loginTimeoutMs: options.loginTimeoutMs,
    openExternal: async (url) => {
      if (options.failBrowser) throw new Error('private provider details');
      opened.push(url);
    },
  });
  return { client, opened, service };
}

async function settle(): Promise<void> { await delay(0); }

test('account client is lazy and checks only account state without token refresh', async () => {
  const { client, service } = fixture();
  assert.equal(client.starts, 0);
  assert.deepEqual(await service.getStatus(), { state: 'signed_out', error: null });
  assert.deepEqual(client.calls, [{ method: 'account/read', params: { refreshToken: false } }]);
  await service.dispose();
});

test('ChatGPT and API key accounts count as signed in and skip browser login', async () => {
  for (const type of ['chatgpt', 'apiKey']) {
    const { client, service, opened } = fixture();
    client.account = { account: { type } };
    assert.equal((await service.getStatus()).state, 'signed_in');
    assert.equal((await service.startLogin()).state, 'signed_in');
    assert.equal(client.calls.some((call) => call.method === 'account/login/start'), false);
    assert.deepEqual(opened, []);
    await service.dispose();
  }
});

test('malformed account responses produce a safe error, not signed out', async () => {
  for (const response of [null, {}, { account: [] }, { account: {} }, { account: { type: 'unknown' } }]) {
    const { client, service } = fixture();
    client.account = response;
    assert.deepEqual(await service.getStatus(), {
      state: 'error', error: 'Could not check Codex login. Please try again.',
    });
    await service.dispose();
  }
});

test('browser login is single flight and keeps authorization data in the main process', async () => {
  const { client, service, opened } = fixture();
  const results = await Promise.all([service.startLogin(), service.startLogin(), service.startLogin()]);
  for (const result of results) assert.deepEqual(result, { state: 'signing_in', error: null });
  assert.equal(client.calls.filter((call) => call.method === 'account/login/start').length, 1);
  assert.deepEqual(client.calls[1], { method: 'account/login/start', params: { type: 'chatgpt' } });
  assert.deepEqual(opened, ['https://auth.openai.com/authorize?state=private']);
  await service.startLogin();
  assert.equal(opened.length, 1);
  await service.dispose();
});

test('only matching successful completion verifies the current account', async () => {
  const { client, service } = fixture();
  await service.startLogin();
  client.emit('account/login/completed', { loginId: 'someone-else', success: true });
  assert.equal((await service.getStatus()).state, 'signing_in');
  client.account = { account: { type: 'chatgpt' } };
  client.emit('account/login/completed', { loginId: 'owned-login', success: true });
  await settle();
  assert.equal((await service.getStatus()).state, 'signed_in');
  await service.dispose();
});

test('completion success requires literal true and never exposes provider errors', async () => {
  for (const success of [false, 'true', 1, undefined]) {
    const { client, service } = fixture();
    await service.startLogin();
    client.emit('account/login/completed', { loginId: 'owned-login', success, error: 'secret-token' });
    const state = await service.getStatus();
    assert.equal(state.state, 'error');
    assert.equal(JSON.stringify(state).includes('secret-token'), false);
    await service.dispose();
  }
});

test('successful notification still requires authenticated account read', async () => {
  const { client, service } = fixture();
  await service.startLogin();
  client.emit('account/login/completed', { loginId: 'owned-login', success: true });
  await settle();
  assert.equal((await service.getStatus()).state, 'signed_out');
  await service.dispose();
});

test('polls detect external login and account updated detects logout', async () => {
  const { client, service } = fixture();
  await service.getStatus();
  client.account = { account: { type: 'chatgpt' } };
  assert.equal((await service.getStatus()).state, 'signed_in');
  client.account = { account: null };
  client.emit('account/updated', { account: null });
  await settle();
  assert.equal((await service.getStatus()).state, 'signed_out');
  await service.dispose();
});

test('unsafe auth URLs never open and their owned login attempt is cancelled', async () => {
  for (const authUrl of ['http://auth.openai.com/a', 'https://auth.openai.com.evil.example/a',
    'https://evil.example/a', 'https://user:pass@auth.openai.com/a', 'file:///tmp/a',
    'https://auth.openai.com:444/a', 'not a url']) {
    const { client, service, opened } = fixture();
    client.login = { type: 'chatgpt', loginId: 'owned-login', authUrl };
    assert.equal((await service.startLogin()).state, 'error');
    assert.deepEqual(opened, []);
    assert.ok(client.calls.some((call) => call.method === 'account/login/cancel'));
    await service.dispose();
  }
});

test('browser errors cancel the owned attempt without exposing details', async () => {
  const { client, service } = fixture({ failBrowser: true });
  assert.deepEqual(await service.startLogin(), { state: 'error', error: 'Could not start Codex login. Please try again.' });
  assert.deepEqual(client.calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } });
  await service.dispose();
});

test('cancelling only cancels this service login and does not log out', async () => {
  const { client, service } = fixture();
  await service.startLogin();
  assert.equal((await service.cancelLogin()).state, 'signed_out');
  client.emit('account/login/completed', { loginId: 'owned-login', success: true });
  assert.equal((await service.getStatus()).state, 'signed_out');
  assert.deepEqual(client.calls.filter((call) => call.method.includes('cancel')), [
    { method: 'account/login/cancel', params: { loginId: 'owned-login' } },
  ]);
  assert.equal(client.calls.some((call) => call.method.includes('logout')), false);
  await service.dispose();
});

test('cancel and close clean a late login start response without opening the browser', async () => {
  for (const close of [false, true]) {
    const { client, service, opened } = fixture();
    const response = createDeferred<unknown>();
    const requested = createDeferred<void>();
    client.override = async (method) => {
      if (method === 'account/login/start') { requested.resolve(); return await response.promise; }
      return method === 'account/read' ? client.account : {};
    };
    const starting = service.startLogin();
    await requested.promise;
    const ending = close ? service.dispose() : service.cancelLogin();
    response.resolve(client.login);
    await starting;
    await ending;
    assert.deepEqual(opened, []);
    assert.deepEqual(client.calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } });
    assert.equal(client.stops, close ? 1 : 0);
    await service.dispose();
  }
});

test('close during account read prevents login start and all future requests', async () => {
  const { client, service, opened } = fixture();
  const response = createDeferred<unknown>();
  const requested = createDeferred<void>();
  client.override = async () => { requested.resolve(); return await response.promise; };
  const starting = service.startLogin();
  await requested.promise;
  const closing = service.dispose();
  response.resolve({ account: null });
  await starting;
  await closing;
  await service.getStatus();
  await service.startLogin();
  await service.cancelLogin();
  await service.dispose();
  assert.equal(client.calls.length, 1);
  assert.equal(client.stops, 1);
  assert.equal(client.notifications.size, 0);
  assert.equal(client.failures.size, 0);
  assert.deepEqual(opened, []);
});

test('stale account refresh cannot overwrite a newly started login and requests are serialized', async () => {
  const { client, service } = fixture();
  const oldRead = createDeferred<unknown>();
  const requested = createDeferred<void>();
  let reads = 0;
  client.override = async (method) => {
    if (method === 'account/read' && ++reads === 1) { requested.resolve(); return await oldRead.promise; }
    return method === 'account/read' ? client.account : client.login;
  };
  const oldRefresh = service.getStatus();
  await requested.promise;
  const starting = service.startLogin();
  await settle();
  assert.equal(client.calls.length, 1);
  oldRead.resolve({ account: { type: 'chatgpt' } });
  assert.equal((await oldRefresh).state, 'signing_in');
  assert.equal((await starting).state, 'signing_in');
  await service.dispose();
});

test('login timeout cancels the attempt and allows a fresh retry', async () => {
  const { client, service } = fixture({ loginTimeoutMs: 5 });
  await service.startLogin();
  await delay(20);
  assert.deepEqual(await service.getStatus(), { state: 'error', error: 'Codex login timed out. Please try again.' });
  assert.ok(client.calls.some((call) => call.method === 'account/login/cancel'));
  assert.equal((await service.startLogin()).state, 'signing_in');
  await service.dispose();
});

test('client failures show generic errors and can recover on the next check', async () => {
  const { client, service } = fixture();
  await service.getStatus();
  for (const listener of client.failures) listener(new Error('private token'));
  assert.deepEqual(await service.getStatus(), { state: 'error', error: 'Could not connect to Codex. Please try again.' });
  client.account = { account: { type: 'chatgpt' } };
  assert.equal((await service.getStatus()).state, 'signed_in');
  await service.dispose();
});

test('completion while the browser opener settles verifies login without resurrecting the attempt', async () => {
  const client = new FakeClient();
  const browserOpened = createDeferred<void>();
  const browserFinished = createDeferred<void>();
  const service = new WorkspaceCodexLoginService({
    client, loginTimeoutMs: 5,
    openExternal: async () => { browserOpened.resolve(); await browserFinished.promise; },
  });
  const starting = service.startLogin();
  await browserOpened.promise;
  client.account = { account: { type: 'chatgpt' } };
  client.emit('account/login/completed', { loginId: 'owned-login', success: true });
  await settle();
  browserFinished.resolve();
  assert.equal((await starting).state, 'signed_in');
  await delay(10);
  assert.equal((await service.getStatus()).state, 'signed_in');
  assert.equal(client.calls.some((call) => call.method === 'account/login/cancel'), false);
  await service.dispose();
});

test('late timeout cancellation cannot replace the state of a newer attempt', async () => {
  const { client, service } = fixture({ loginTimeoutMs: 5 });
  const cancelled = createDeferred<void>();
  const cancelledReply = createDeferred<unknown>();
  client.override = async (method) => {
    if (method === 'account/login/cancel') { cancelled.resolve(); return await cancelledReply.promise; }
    return method === 'account/read' ? client.account : client.login;
  };
  await service.startLogin();
  const keepAlive = delay(15);
  await cancelled.promise;
  client.account = { account: { type: 'chatgpt' } };
  const retry = service.startLogin();
  cancelledReply.resolve({});
  assert.equal((await retry).state, 'signed_in');
  await keepAlive;
  assert.deepEqual(await service.getStatus(), { state: 'signed_in', error: null });
  await service.dispose();
});

test('external login while a browser login is pending cancels only the abandoned owned attempt', async () => {
  const { client, service } = fixture();
  await service.startLogin();
  client.account = { account: { type: 'apiKey' } };
  assert.equal((await service.getStatus()).state, 'signed_in');
  assert.deepEqual(client.calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } });
  await service.dispose();
});

test('failed polling cancels a pending attempt so retry can start another login', async () => {
  const { client, service } = fixture();
  await service.startLogin();
  client.account = {};
  assert.equal((await service.getStatus()).state, 'error');
  assert.deepEqual(client.calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } });
  client.account = { account: null };
  assert.equal((await service.startLogin()).state, 'signing_in');
  assert.equal(client.calls.filter((call) => call.method === 'account/login/start').length, 2);
  await service.dispose();
});
