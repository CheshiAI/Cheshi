import { describe, expect, test } from 'bun:test';
import { deepStrictEqual, rejects } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAccountService } from '../lib/codex-account-service.mts';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';

type CodexAccountClient = ConstructorParameters<typeof CodexAccountService>[0]['client'];
type NotificationListener = Parameters<CodexAccountClient['onNotification']>[0];
type FailureListener = Parameters<CodexAccountClient['onDidFail']>[0];

function createFakeAppServer(directory: string): string {
  const script = join(directory, 'fake-app-server.mjs');
  writeFileSync(script, `
import readline from 'node:readline';

let initialized = false;
const input = readline.createInterface({ input: process.stdin });

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

input.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.method === 'initialize') {
    send({ id: value.id, result: { userAgent: 'fake-codex/1.0' } });
    return;
  }
  if (value.method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized) {
    send({ id: value.id, error: { message: 'Not initialized' } });
    return;
  }
  if (value.method === 'account/read') {
    send({ id: value.id, result: { account: { type: 'chatgpt', planType: 'pro' } } });
    return;
  }
  if (value.method === 'test/notify') {
    send({ id: value.id, result: {} });
    send({ method: 'account/rateLimits/updated', params: { rateLimits: {} } });
    return;
  }
  if (value.method === 'test/client-notification') {
    send({ method: 'test/client-notification-received', params: value.params });
    return;
  }
  if (value.method === 'test/server-request') {
    send({ id: value.id, result: {} });
    send({ id: 'server-request-1', method: 'test/approval', params: { reason: 'verify response' } });
    return;
  }
  if (value.id === 'server-request-1' && value.result?.approved === true) {
    send({ method: 'test/server-response-received', params: {} });
    return;
  }
  send({ id: value.id, result: {} });
});
`);
  return script;
}

function createFakeAppServerClient() {
  const notificationListeners = new Set<NotificationListener>();
  const failureListeners = new Set<FailureListener>();
  const requests: string[] = [];

  function subscribeToNotifications(listener: NotificationListener) {
    notificationListeners.add(listener);
    return () => {
      notificationListeners.delete(listener);
    };
  }

  function subscribeToFailures(listener: FailureListener) {
    failureListeners.add(listener);
    return () => { failureListeners.delete(listener); };
  }

  const client = {
    sparkUsedPercent: 0,
    requests,
    onNotification: subscribeToNotifications,
    onDidFail: subscribeToFailures,
    async start() {},

    async request(method: string, _params?: unknown): Promise<unknown> {
      void _params;
      requests.push(method);
      if (method === 'account/read') {
        return { account: { type: 'chatgpt', planType: 'pro' } };
      }
      if (method === 'account/rateLimits/read') {
        return {
          rateLimitsByLimitId: {
            codex_spark: {
              limitId: 'codex_spark',
              limitName: 'GPT-5.3-Codex-Spark',
              planType: 'pro',
              primary: {
                usedPercent: client.sparkUsedPercent,
                windowDurationMins: 300,
                resetsAt: 1_787_179_860,
              },
              secondary: {
                usedPercent: 12,
                windowDurationMins: 10_080,
                resetsAt: 1_787_894_940,
              },
            },
            codex: {
              limitId: 'codex',
              planType: 'pro',
              primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_787_179_860 },
              secondary: { usedPercent: 15, windowDurationMins: 10_080, resetsAt: 1_787_612_940 },
            },
            malformed: {
              primary: { usedPercent: 'invalid' },
            },
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    },

    async stop() {},

    emitNotification(method: string) {
      for (const listener of notificationListeners) listener({ method, params: {} });
    },
    emitFailure(error: Error) {
      for (const listener of failureListeners) listener(error);
    },
  };
  return client;
}

describe('CodexAppServerClient', () => {
  test('completes the initialization handshake before account requests and forwards notifications', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cheshi-codex-client-'));
    const client = new CodexAppServerClient({
      command: {
        executable: process.execPath,
        args: [createFakeAppServer(directory)],
        environment: {},
      },
      cwd: directory,
      clientInfo: { name: 'cheshi-test', title: 'Cheshi Test', version: '0.0.0' },
      requestTimeoutMs: 5_000,
    });
    let removeListener = () => {};
    let removeClientNotificationListener = () => {};
    let removeRequestListener = () => {};
    let removeResponseListener = () => {};
    const removeFailureListener = client.onDidFail(() => {});
    /** @type {Promise<Record<string, unknown>>} */
    const notification = new Promise((resolve) => {
      removeListener = client.onNotification(resolve);
    });

    try {
      expect(await client.start()).toEqual({ userAgent: 'fake-codex/1.0' });
      const accountResponse = await client.request('account/read', { refreshToken: false });
      if (typeof accountResponse !== 'object' || accountResponse === null || Array.isArray(accountResponse)) {
        throw new Error('Expected account/read to return an object.');
      }
      deepStrictEqual(accountResponse, {
        account: { type: 'chatgpt', planType: 'pro' },
      });
      const notifyResponse = await client.request('test/notify');
      if (typeof notifyResponse !== 'object' || notifyResponse === null || Array.isArray(notifyResponse)) {
        throw new Error('Expected test/notify to return an object.');
      }
      deepStrictEqual(notifyResponse, {});
      expect(await notification).toMatchObject({ method: 'account/rateLimits/updated' });

      /** @type {Promise<Record<string, unknown>>} */
      const clientNotificationReceived = new Promise((resolve) => {
        removeClientNotificationListener = client.onNotification((value) => {
          if (value.method === 'test/client-notification-received') resolve(value);
        });
      });
      await client.notify('test/client-notification', { source: 'client' });
      deepStrictEqual(await clientNotificationReceived, {
        method: 'test/client-notification-received',
        params: { source: 'client' },
      });

      /** @type {Promise<Record<string, unknown>>} */
      const serverRequest = new Promise((resolve) => {
        removeRequestListener = client.onRequest(resolve);
      });
      /** @type {Promise<Record<string, unknown>>} */
      const responseReceived = new Promise((resolve) => {
        removeResponseListener = client.onNotification((value) => {
          if (value.method === 'test/server-response-received') resolve(value);
        });
      });
      const serverRequestResponse = await client.request('test/server-request');
      deepStrictEqual(serverRequestResponse, {});
      const incomingRequest = await serverRequest;
      deepStrictEqual(incomingRequest, {
        id: 'server-request-1',
        method: 'test/approval',
        params: { reason: 'verify response' },
      });
      if (typeof incomingRequest.id !== 'string' && typeof incomingRequest.id !== 'number') {
        throw new Error('Expected a server request id.');
      }
      await client.respond(incomingRequest.id, { approved: true });
      expect(await responseReceived).toMatchObject({ method: 'test/server-response-received' });
    } finally {
      removeListener();
      removeClientNotificationListener();
      removeRequestListener();
      removeResponseListener();
      removeFailureListener();
      await client.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('CodexAccountService shutdown', () => {
  for (const phase of ['start', 'account/read', 'account/rateLimits/read']) {
    test(`ignores ${phase} rejection after intentional stop`, async () => {
      const client = createFakeAppServerClient();
      const pending = createDeferred<unknown>();
      const entered = createDeferred<void>();
      const request = client.request.bind(client);
      if (phase === 'start') {
        client.start = async () => { entered.resolve(); await pending.promise; };
      } else {
        client.request = async (method, params) => {
          if (method !== phase) return request(method, params);
          entered.resolve();
          return pending.promise;
        };
      }
      const logs: string[] = [];
      const states: string[] = [];
      const service = new CodexAccountService({ client, log: (event) => logs.push(event) });
      service.onDidChange((status) => states.push(status.state));
      const status = service.getStatus();
      await entered.promise;
      await service.stop();
      states.length = 0;
      pending.reject(new Error('Codex App Server exited (code none, signal SIGTERM).'));
      expect((await status).state).toBe('stopped');
      expect(service.started).toBe(false);
      expect(states).toEqual([]);
      expect(logs).toEqual([]);
    });
  }

  test('ignores stale notification refresh failure after restarting and keeps real failures visible', async () => {
    const client = createFakeAppServerClient();
    const logs: string[] = [];
    const states: string[] = [];
    const service = new CodexAccountService({ client, log: (event) => logs.push(event) });
    service.onDidChange((status) => states.push(status.state));
    await service.getStatus();
    const pending = createDeferred<unknown>();
    const request = client.request.bind(client);
    client.request = () => pending.promise;
    client.emitNotification('account/updated');
    const refresh = service.refreshPromise;
    await service.stop();
    client.request = request;
    expect((await service.getStatus()).state).toBe('ready');
    states.length = 0;
    pending.reject(new Error('Old client stopped'));
    await rejects(async () => { await refresh; }, /Old client stopped/);
    await Promise.resolve();
    expect(service.status.state).toBe('ready');
    expect(states).toEqual([]);
    expect(logs).toEqual([]);
    client.emitFailure(new Error('Codex App Server exited (code none, signal SIGTERM).'));
    expect(states).toEqual(['error']);
    expect(logs).toEqual(['codex-account-failed']);
    await service.stop();
  });
});

describe('CodexAccountService', () => {
  for (const [failure, expected] of [
    ['HTTP 401 Unauthorized: sensitive upstream details', 'Usage authentication failed (401). Log out of this account and sign in again.'],
    ['Request timed out: sensitive upstream details', 'The usage request timed out. Refresh to try again.'],
    ['Network unavailable: sensitive upstream details', 'Unable to load account usage. Refresh to try again.'],
  ] as const) {
    test(`reports usage failure safely and clears it after recovery: ${failure.split(':')[0]}`, async () => {
      const client = createFakeAppServerClient();
      const request = client.request.bind(client);
      client.request = async (method, params) => {
        if (method === 'account/rateLimits/read') throw new Error(failure);
        return request(method, params);
      };
      const service = new CodexAccountService({ client });
      try {
        const status = await service.getStatus();
        expect(status).toMatchObject({ state: 'error', authenticated: true, plan: 'pro', rateLimits: [], error: expected });
        client.request = request;
        const recovered = await service.getStatus();
        expect(recovered.state).toBe('ready');
        expect(recovered.error).toBeNull();
        expect(recovered.rateLimits.length).toBeGreaterThan(0);
      } finally { await service.stop(); }
    });
  }

  test('normalizes plan, weekly usage, and Spark limits and refreshes on notifications', async () => {
    const client = createFakeAppServerClient();
    const service = new CodexAccountService({ client });

    try {
      const initial = await service.getStatus();
      expect(initial.state).toBe('ready');
      expect(initial.authenticated).toBe(true);
      if (initial.plan === null) throw new Error('Expected an authenticated account plan.');
      expect(initial.plan).toBe('pro');
      expect(initial.rateLimits).toHaveLength(2);
      const codexLimit = initial.rateLimits.find((limit) => limit.limitId === 'codex');
      if (!codexLimit) throw new Error('Expected the Codex rate limit.');
      expect(codexLimit).toMatchObject({
        primary: { usedPercent: 28, windowDurationMins: 300 },
        secondary: { usedPercent: 15, windowDurationMins: 10_080 },
      });
      const sparkLimit = initial.rateLimits.find((limit) => limit.limitId === 'codex_spark');
      if (!sparkLimit) throw new Error('Expected the Spark rate limit.');
      expect(sparkLimit).toMatchObject({
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_179_860 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_787_894_940 },
      });

      let removeListener = () => {};
      /** @type {Promise<number>} */
      const refreshedUsedPercent = new Promise((resolve) => {
        removeListener = service.onDidChange((status) => {
          const spark = status.rateLimits.find((limit) => limit.limitId === 'codex_spark');
          if (spark?.primary?.usedPercent === 41) resolve(spark.primary.usedPercent);
        });
      });
      client.sparkUsedPercent = 41;
      client.emitNotification('account/rateLimits/updated');
      expect(await refreshedUsedPercent).toBe(41);
      removeListener();
      deepStrictEqual(client.requests, [
        'account/read',
        'account/rateLimits/read',
        'account/read',
        'account/rateLimits/read',
      ]);
    } finally {
      await service.stop();
    }
  });
});
