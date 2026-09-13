import { expect, test } from 'bun:test';
import { CodexAccountClients } from '../lib/codex-account-clients.mts';

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

function createClient(pool: CodexAccountClients) {
  const client = pool.create({
    command: { executable: 'unused-test-transport', args: [], environment: {} },
    cwd: '/tmp', clientInfo: { name: 'account-test', title: 'Account test', version: '1' },
  });
  // Keep the production generation and request guards while injecting the transport boundary.
  client.startInternal = async () => ({});
  client.requestRaw = async () => ({ ok: true });
  return client;
}

test('switch retires old conversation clients and rebinds only retained clients', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const retained = createClient(pool);
  const oldConversation = createClient(pool);
  let resets = 0;
  await pool.change({ CODEX_HOME: '/second', OPENAI_API_KEY: undefined }, [retained], async () => { resets += 1; });
  expect(resets).toBe(1);
  expect(retained.command.environment).toEqual({ CODEX_HOME: '/second', OPENAI_API_KEY: undefined });
  await expectFailure(oldConversation.request('thread/resume'), 'previous account');
  expect(await retained.request('account/read')).toEqual({ ok: true });
  expect(pool.clients.has(retained)).toBe(true);
  expect(pool.clients.has(oldConversation)).toBe(false);
  await pool.stop();
});

test('returning to default removes profile-specific environment overrides', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const client = createClient(pool);
  await pool.change({ CODEX_HOME: '/second', OPENAI_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined }, [client], async () => {});
  await pool.change({ CODEX_HOME: '/default' }, [client], async () => {});
  expect(client.command.environment).toEqual({ CODEX_HOME: '/default' });
  expect(Object.hasOwn(client.command.environment, 'OPENAI_API_KEY')).toBe(false);
  await pool.stop();
});

test('an outstanding request blocks switching until its result settles', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const client = createClient(pool);
  const response = createDeferred<unknown>();
  client.requestRaw = () => response.promise;
  const pending = client.request('thread/read');
  await expectFailure(pool.change({ CODEX_HOME: '/second' }, [client], async () => {}), 'requests and responses');
  expect(pool.environment.CODEX_HOME).toBe('/default');
  response.resolve({ done: true });
  expect(await pending).toEqual({ done: true });
  await pool.change({ CODEX_HOME: '/second' }, [client], async () => {});
  await pool.stop();
});

test('turn notifications keep a completed start request busy until the turn completes', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const client = createClient(pool);
  const notify = (method: string) => {
    for (const listener of client.notificationListeners) listener({ method, params: { threadId: 'thread-a' } });
  };
  notify('turn/started');
  await expectFailure(pool.change({ CODEX_HOME: '/second' }, [], async () => {}), 'requests and responses');
  notify('turn/completed');
  await pool.change({ CODEX_HOME: '/second' }, [client], async () => {});
  await pool.stop();
});

test('switch excludes concurrent switches and new transport requests during reset', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const client = createClient(pool);
  const resetting = createDeferred<void>();
  const release = createDeferred<void>();
  const switching = pool.change({ CODEX_HOME: '/second' }, [client], async () => { resetting.resolve(); await release.promise; });
  await resetting.promise;
  await expectFailure(pool.change({ CODEX_HOME: '/third' }, [], async () => {}), 'switch to finish');
  await expectFailure(client.request('thread/start'), 'switch to finish');
  release.resolve();
  await switching;
  expect(pool.generation).toBe(1);
  await pool.stop();
});

test('shutdown failure preserves the old account and prevents reset', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const client = createClient(pool);
  const originalStop = client.stop.bind(client);
  client.stop = async () => { throw new Error('Unable to terminate old process'); };
  let resets = 0;
  await expectFailure(pool.change({ CODEX_HOME: '/second' }, [client], async () => { resets += 1; }), 'Unable to terminate');
  expect(pool.environment.CODEX_HOME).toBe('/default');
  expect(pool.generation).toBe(0);
  expect(pool.switching).toBe(false);
  expect(resets).toBe(0);
  await expectFailure(pool.stop(), 'Unable to terminate');
  client.stop = originalStop;
  await pool.stop();
});

test('closing the workspace during reset prevents account rebinding', async () => {
  const pool = new CodexAccountClients({ CODEX_HOME: '/default' });
  const client = createClient(pool);
  await expectFailure(pool.change({ CODEX_HOME: '/second' }, [client], () => pool.stop()), 'workspace has closed');
  expect(pool.environment.CODEX_HOME).toBe('/default');
  expect(pool.generation).toBe(0);
  await expectFailure(client.request('account/read'), 'workspace has closed');
  expect(() => createClient(pool)).toThrow('workspace has closed');
});
