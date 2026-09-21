import { afterEach, expect, test } from 'bun:test';
import { createWorkspaceHistoryMcp, type HistoryRecallAccess } from '../lib/workspace-history-mcp.mts';
import { createHistoryRecallEvaluator } from '../lib/chat-history-recall-model.mts';
import { ChatHistoryRecall } from '../lib/chat-history-recall.mts';
import { ChatHistorySearch } from '../lib/chat-history-search.mts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerClient } from '../lib/codex-app-server-client.mts';
import { isolatedCodexTestEnvironment } from './isolated-codex-test-environment';
import { recordValue } from '../lib/codex-service-utils.mts';
import { recallResponseUsage } from '../lib/chat-history-recall-usage.mts';
import { historyRecallFromMcp } from '../shared/history-recall';

const servers: ReturnType<typeof createWorkspaceHistoryMcp>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const allowed: HistoryRecallAccess = { enabled: () => true, subscribe: () => () => {} };

async function fixture(recall: Pick<ChatHistoryRecall, 'search' | 'read'>, access: HistoryRecallAccess = allowed) {
  const server = createWorkspaceHistoryMcp(recall, access);
  servers.push(server);
  const command: { environment?: NodeJS.ProcessEnv } = { environment: { CODEX_HOME: '/test-only' } };
  const args = await server.prepareCommand(command);
  const configuration = Bun.TOML.parse(args.filter((_, index) => index % 2 === 1).join('\n')) as {
    mcp_servers: { cheshi_history: { url: string; bearer_token_env_var: string } };
  };
  const connection = configuration.mcp_servers.cheshi_history;
  const authorization = `Bearer ${command.environment?.[connection.bearer_token_env_var]}`;
  const post = (message: unknown, session?: string, extraHeaders: Record<string, string> = {}) => fetch(connection.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: authorization, ...(session ? { 'Mcp-Session-Id': session } : {}), ...extraHeaders }, body: JSON.stringify(message),
  });
  const initialize = async () => {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect((await response.json()).result.serverInfo.name).toBe('cheshi_history');
    return response.headers.get('mcp-session-id')!;
  };
  return { server, args, post, initialize, connection, authorization };
}

function unavailable(): Pick<ChatHistoryRecall, 'search' | 'read'> {
  return { async search() { throw new Error('not configured'); }, async read() { throw new Error('not configured'); } };
}

test('authenticates MCP, lists read-only tools, dispatches calls and rejects browser origins', async () => {
  let searches = 0;
  const f = await fixture({ ...unavailable(), async search() { searches++; throw new Error('Register a TypeSafe key.'); } });
  expect(f.args.join(' ')).not.toContain(f.authorization.slice(7));
  const session = await f.initialize();
  const notification = await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  expect(notification.status).toBe(202);
  const listed = await f.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  expect((await listed.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['history_search', 'history_read']);
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'history_search', arguments: { query: 'why', threadId: 'thread' } } };
  expect((await f.post(call, session, { Origin: 'https://unrelated.example' })).status).toBe(403);
  expect((await f.post(call, session, { Authorization: 'Bearer wrong' })).status).toBe(403);
  expect((await f.post(call, session, { Host: 'unrelated.example' })).status).toBe(403);
  expect(searches).toBe(0);
  const result = await (await f.post(call, session)).json();
  expect(result.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Register a TypeSafe key.' }] });
  expect(searches).toBe(1);
  expect((await f.post(call, 'missing')).status).toBe(404);
});

test('cancels only the named MCP session request and returns a tool error', async () => {
  const entered = createDeferred<void>();
  const f = await fixture({ ...unavailable(), async search(_args, signal) {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Search cancelled.')), { once: true });
    });
    throw new Error('Unexpected resolution.');
  } });
  const first = await f.initialize();
  const second = await f.initialize();
  const pending = f.post({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'history_search', arguments: {} } }, first);
  await entered.promise;
  expect((await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call' } }, second)).status).toBe(202);
  expect((await f.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call' } }, first)).status).toBe(202);
  expect((await (await pending).json()).result.content[0].text).toBe('History recall was canceled or disabled.');
});

test('deleting an MCP session revokes its access and shutdown closes the listener', async () => {
  const f = await fixture(unavailable());
  const session = await f.initialize();
  const response = await fetch(f.connection.url, { method: 'DELETE', headers: { Authorization: f.authorization, 'Mcp-Session-Id': session } });
  expect(response.status).toBe(200);
  expect((await f.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).status).toBe(404);
  await f.server.stop();
  let failed = false;
  try { await fetch(f.connection.url); } catch { failed = true; }
  expect(failed).toBe(true);
});

test('MCP search and source reads return original evidence through the complete local pipeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-history-pipeline-'));
  const history = new ChatHistorySearch({ directory, cwd: directory, source: {
    async list() { return { sessions: [{ id: 'past', title: 'Past decision', updatedAt: 1 }] }; },
    async read() { return { thread: { id: 'past', cwd: directory, turns: [{ id: 'decision', items: [
      { id: 'reason', type: 'agentMessage', text: '자격 증명 격리가 안 되어 중단했습니다.' },
    ] }] } }; },
  } });
  try {
    const setting = consent();
    let evaluations = 0;
    const recall = new ChatHistoryRecall({ history, evaluate: async (query, candidates, _signal, onUsage) => {
      evaluations++;
      onUsage?.(recallResponseUsage({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 10 } }, 5));
      if (query === 'failure') throw new Error('Invalid provider assessment.');
      return candidates.map(() => ({ answer: 0.95, related: 0.9, direct: 0.9 }));
    } });
    const f = await fixture(recall, setting.access);
    const session = await f.initialize();
    const search = await (await f.post({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'history_search', arguments: { query: '계정 전환 포기 사유?', threadId: 'past' } } }, session)).json();
    const payload = JSON.parse(search.result.content[0].text);
    const match = payload.matches[0];
    setting.set(false);
    const blocked = await (await f.post({ jsonrpc: '2.0', id: 'cached', method: 'tools/call',
      params: { name: 'history_search', arguments: { query: '계정 전환 포기 사유?', threadId: 'past' } } }, session)).json();
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.content[0].text).not.toContain('자격 증명');
    expect(evaluations).toBe(1);
    setting.set(true);
    expect(payload.metrics.estimatedCostUsd).toBeCloseTo(0.000042, 10);
    expect(payload.originals).toMatchObject([{ threadId: 'past', turnId: 'decision', itemId: 'reason',
      text: '자격 증명 격리가 안 되어 중단했습니다.', offset: 0, nextOffset: null, truncated: false }]);
    expect(historyRecallFromMcp('cheshi_history', 'history_search', search.result)).toMatchObject({
      operation: 'search', metrics: { requests: 1 }, sources: [{ threadId: 'past', turnId: 'decision', itemId: 'reason' }],
    });
    expect(match).toMatchObject({ threadId: 'past', turnId: 'decision', itemId: 'reason' });
    const read = await (await f.post({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'history_read', arguments: { threadId: match.threadId, turnId: match.turnId, itemId: match.itemId } } }, session)).json();
    expect(JSON.parse(read.result.content[0].text).text).toBe('자격 증명 격리가 안 되어 중단했습니다.');
    const failure = await (await f.post({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'history_search', arguments: { query: 'failure', threadId: 'past' } } }, session)).json();
    expect(failure.result.isError).toBe(true);
    expect(JSON.parse(failure.result.content[0].text)).toMatchObject({ status: 'error', metrics: { requests: 1, inputTokens: 1000 } });
  } finally { await history.stop(); await rm(directory, { recursive: true, force: true }); }
});

// Local protocol compatibility only: isolated home, offline provider, no turns or model requests.
const runtimeTest = process.env.CHESHI_TEST_REAL_CODEX === '1' ? test : test.skip;
async function seedSavedHistory(directory: string) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const folder = join(directory, 'sessions', ...timestamp.slice(0, 10).split('-'));
  await mkdir(folder, { recursive: true });
  const path = join(folder, `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  const records = [
    { timestamp, type: 'session_meta', payload: { id, timestamp, cwd: directory, originator: 'cheshi-history-test',
      cli_version: '0.154.0', source: 'cli', model_provider: 'offline', base_instructions: { text: 'Offline fixture.' } } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '과거 기록입니다.' }] } },
  ];
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return { id, path };
}

runtimeTest('installed Codex discovers history tools in new and resumed threads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-history-codex-'));
  const bridge = createWorkspaceHistoryMcp(unavailable(), allowed);
  servers.push(bridge);
  const command = { executable: process.env.CHESHI_CODEX?.trim() || 'codex', args: ['app-server', '--listen', 'stdio://'],
    environment: isolatedCodexTestEnvironment(directory) };
  let client: CodexAppServerClient | undefined;
  try {
    await writeFile(join(directory, 'config.toml'), [
      'model = "offline-test"', 'model_provider = "offline"', '[model_providers.offline]',
      'name = "Offline history fixture"', 'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"', 'requires_openai_auth = false', '',
    ].join('\n'));
    command.args.push(...await bridge.prepareCommand(command));
    const create = () => new CodexAppServerClient({ command, cwd: directory,
      clientInfo: { name: 'cheshi-history-test', title: 'History protocol test', version: '1' },
      capabilities: { experimentalApi: true }, requestTimeoutMs: 10_000 });
    client = create();
    const created = recordValue(await client.request('thread/start', {
      cwd: directory, model: 'offline-test', modelProvider: 'offline', approvalPolicy: 'never', sandbox: 'read-only',
    }));
    let threadId = recordValue(created?.thread)?.id;
    expect(typeof threadId).toBe('string');
    for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
      if (lifecycle) {
        await client.stop();
        client = create();
        const saved = await seedSavedHistory(directory);
        threadId = saved.id;
        await client.request('thread/resume', { threadId, path: saved.path, cwd: directory, model: 'offline-test', modelProvider: 'offline',
          approvalPolicy: 'never', sandbox: 'read-only' });
      }
      let discovered: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const response = recordValue(await client.request('mcpServerStatus/list', { threadId, limit: 100 }));
        const list = Array.isArray(response?.data) ? response.data : [];
        const server = list.map(recordValue).find(server => server?.name === 'cheshi_history');
        discovered = recordValue(server?.tools);
        if (discovered && Object.keys(discovered).length === 2) break;
        await delay(50);
      }
      expect(Object.keys(discovered ?? {}).sort()).toEqual(['history_read', 'history_search']);
    }
  } finally { await client?.stop(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);


function consent(initial: unknown = true) {
  let value = initial;
  const listeners = new Set<() => void>();
  const access: HistoryRecallAccess = {
    // Malformed external preferences are injected only at this boundary.
    enabled: () => value as boolean,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { access, listeners, set(next: unknown) { value = next; for (const listener of listeners) listener(); } };
}

test('absent, false and malformed consent disable registration without injecting credentials', async () => {
  for (const value of [undefined, false, 'true', 1, null, {}]) {
    const access = value === undefined ? undefined : consent(value).access;
    const server = createWorkspaceHistoryMcp(unavailable(), access);
    servers.push(server);
    const command = { environment: { CODEX_HOME: '/test-only' } };
    expect(await server.prepareCommand(command)).toEqual(['-c', 'mcp_servers.cheshi_history={ enabled = false, url = "http://127.0.0.1:9/mcp" }']);
    expect(command.environment).toEqual({ CODEX_HOME: '/test-only' });
  }
});

test('revoking consent blocks searches and source reads from already connected clients', async () => {
  const setting = consent();
  let searches = 0, reads = 0;
  const f = await fixture({
    async search() { searches++; throw new Error('fixture search'); },
    async read() { reads++; throw new Error('fixture read'); },
  }, setting.access);
  const session = await f.initialize();
  setting.set(false);
  const list = await (await f.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).json();
  expect(list.result.tools).toEqual([]);
  for (const name of ['history_search', 'history_read']) {
    const response = await (await f.post({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } }, session)).json();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('disabled');
  }
  expect(searches).toBe(0);
  expect(reads).toBe(0);
  setting.set(true);
  const restored = await (await f.post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, session)).json();
  expect(restored.result.tools).toHaveLength(2);
  await f.server.stop();
  expect(setting.listeners.size).toBe(0);
});

test('revocation cancels every workspace request and suppresses late results after re-enabling', async () => {
  const setting = consent();
  const entered = [createDeferred<void>(), createDeferred<void>()];
  const release = createDeferred<void>();
  const signals: AbortSignal[] = [];
  const pending: Promise<Response>[] = [];
  for (let i = 0; i < 2; i++) {
    const f = await fixture({ ...unavailable(), async search(_args, signal) {
      signals.push(signal);
      entered[i]!.resolve();
      await release.promise; // Model double intentionally ignores cancellation.
      throw new Error('late private result');
    } }, setting.access);
    const session = await f.initialize();
    pending.push(f.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'history_search', arguments: {} } }, session));
  }
  await Promise.all(entered.map(entry => entry.promise));
  setting.set(false);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  setting.set(true);
  release.resolve();
  for (const response of await Promise.all(pending)) {
    const result = (await response.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('late private result');
  }
});


for (const provider of ['jev', 'luna'] as const) {
  test(`switching recall off aborts ${provider} and never starts another provider`, async () => {
    const setting = consent();
    const entered = createDeferred<void>();
    let jevCalls = 0, lunaCalls = 0;
    let providerSignal: AbortSignal | undefined;
    const waitForCancellation = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      providerSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered.resolve();
    });
    const evaluate = createHistoryRecallEvaluator({
      getKey: () => 'fixture-secret',
      request: async (_url, options) => {
        jevCalls++;
        if (provider === 'luna') return new Response('', { status: 429 });
        return waitForCancellation(options.signal!);
      },
      fallback: async (_query, _candidates, signal) => { lunaCalls++; return waitForCancellation(signal); },
    });
    const f = await fixture({ ...unavailable(), async search(_args, signal) {
      await evaluate('fixture', [{ id: 'sample', text: 'sample', before: '', after: '' }], signal);
      throw new Error('Unexpected successful evaluation.');
    } }, setting.access);
    const session = await f.initialize();
    const pending = f.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'history_search', arguments: {} } }, session);
    await entered.promise;
    setting.set(false);
    const response = (await (await pending).json()).result;
    expect(providerSignal?.aborted).toBe(true);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).not.toContain('fixture-secret');
    expect(jevCalls).toBe(1);
    expect(lunaCalls).toBe(provider === 'luna' ? 1 : 0);
  });
}


runtimeTest('installed Codex accepts disabled recall configuration without discovering history tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-history-disabled-'));
  const bridge = createWorkspaceHistoryMcp(unavailable());
  servers.push(bridge);
  const command = { executable: process.env.CHESHI_CODEX?.trim() || 'codex', args: ['app-server', '--listen', 'stdio://'],
    environment: isolatedCodexTestEnvironment(directory) };
  let client: CodexAppServerClient | undefined;
  try {
    await writeFile(join(directory, 'config.toml'), [
      'model = "offline-test"', 'model_provider = "offline"', '[model_providers.offline]',
      'name = "Offline history fixture"', 'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"', 'requires_openai_auth = false', '',
    ].join('\n'));
    command.args.push(...await bridge.prepareCommand(command));
    client = new CodexAppServerClient({ command, cwd: directory,
      clientInfo: { name: 'cheshi-history-test', title: 'Disabled recall test', version: '1' },
      capabilities: { experimentalApi: true }, requestTimeoutMs: 10_000 });
    const created = recordValue(await client.request('thread/start', {
      cwd: directory, model: 'offline-test', modelProvider: 'offline', approvalPolicy: 'never', sandbox: 'read-only',
    }));
    const threadId = recordValue(created?.thread)?.id;
    expect(typeof threadId).toBe('string');
    const response = recordValue(await client.request('mcpServerStatus/list', { threadId, limit: 100 }));
    const list = Array.isArray(response?.data) ? response.data : [];
    const history = list.map(recordValue).find(server => server?.name === 'cheshi_history');
    expect(Object.keys(recordValue(history?.tools) ?? {})).toEqual([]);
  } finally { await client?.stop(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
