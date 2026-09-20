import { expect, test } from 'bun:test';
import { createLunaHistoryRecallEvaluator } from '../lib/chat-history-recall-luna.mts';
import { createHistoryRecallEvaluator } from '../lib/chat-history-recall-model.mts';
import { addRecallUsage, emptyRecallUsage } from '../lib/chat-history-recall-usage.mts';
import type { CodexChatClient, JsonObject } from '../lib/codex-chat-types.mts';
import { recordValue } from '../lib/codex-service-utils.mts';

const candidates = [{ id: 'one', text: 'Jev는 이전 대화 검색에 사용한다.', before: '', after: '' },
  { id: 'two', text: '확인해보겠습니다.', before: '', after: '' }];
const rows = [{ i: 1, a: 0, r: 1, d: 0 }, { i: 0, a: 2, r: 2, d: 2 }];

function fixture() {
  const notifications = new Set<(value: JsonObject) => void>();
  const requests = new Set<(value: JsonObject) => void>();
  const failures = new Set<(error: Error) => void>();
  const calls: { method: string; params: JsonObject }[] = [];
  const handlers = new Map<string, (params: JsonObject) => Promise<unknown>>();
  let stops = 0;
  const notify = (method: string, params: JsonObject) => {
    for (const listener of notifications) listener({ method, params });
  };
  const client: CodexChatClient & { stop(): Promise<void> } = {
    async request(method, value) {
      const params = recordValue(value) ?? {};
      calls.push({ method, params });
      if (handlers.has(method)) return handlers.get(method)!(params);
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: { mcp_servers: { cheshi_history: { url: 'http://localhost/mcp' } } } };
      if (method === 'model/list') return { data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna',
        displayName: 'Luna', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
      if (method === 'thread/start') return { thread: { id: 'recall', ephemeral: true }, model: 'gpt-5.6-luna', modelProvider: 'openai', serviceTier: 'default' };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      return {};
    },
    async respond() {},
    async stop() { stops++; },
    onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
    onRequest(listener) { requests.add(listener); return () => { requests.delete(listener); }; },
    onDidFail(listener) { failures.add(listener); return () => { failures.delete(listener); }; },
  };
  return { client, calls, handlers, notifications, requests, failures, notify, stops: () => stops,
    complete(text = JSON.stringify({ rows })) {
      notify('turn/completed', { threadId: 'recall', turn: { id: 'turn', status: 'completed',
        items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text }] } });
    } };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected event missing');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function failure(operation: Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

function evaluate(f: ReturnType<typeof fixture>, timeoutMs = 1000) {
  return createLunaHistoryRecallEvaluator({ createClient: () => f.client, cwd: '/workspace', timeoutMs });
}

test('quota failure uses the active subscription, exact low/default model, no tools and separate usage', async () => {
  const f = fixture(), usage = emptyRecallUsage();
  const primary = createHistoryRecallEvaluator({ getKey: () => 'test-only',
    request: async () => new Response('', { status: 429 }), fallback: evaluate(f) });
  const pending = primary('Jev 용도?', candidates, new AbortController().signal, value => addRecallUsage(usage, value));
  await until(() => f.calls.some(call => call.method === 'turn/start'));
  const start = f.calls.find(call => call.method === 'thread/start')!.params;
  expect(start).toMatchObject({ model: 'gpt-5.6-luna', ephemeral: true, allowProviderModelFallback: false,
    serviceTier: 'default', modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'never', dynamicTools: [], selectedCapabilityRoots: [],
    config: { mcp_servers: { cheshi_history: { enabled: false } }, 'features.shell_tool': false, 'features.multi_agent': false, web_search: 'disabled' } });
  const turn = f.calls.find(call => call.method === 'turn/start')!.params;
  expect(turn).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'default', serviceTierForTurn: 'default',
    outputSchema: { type: 'object' }, sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  f.notify('thread/tokenUsage/updated', { threadId: 'recall', tokenUsage: { total: {
    inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 10, cachedInputTokens: 50 } } });
  f.complete();
  expect(await pending).toEqual([{ answer: 1, related: 1, direct: 1 }, { answer: 0, related: 0.5, direct: 0 }]);
  expect(usage).toMatchObject({ requests: 1, inputTokens: null, estimatedCostUsd: null, unknownRequests: 1,
    luna: { requests: 1, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 10, cachedInputTokens: 50 } });
  expect(f.stops()).toBe(1);
  expect(f.notifications.size + f.requests.size + f.failures.size).toBe(0);
});

test.each(['not json', JSON.stringify({ rows: rows.slice(1) }), JSON.stringify({ rows: [rows[0], rows[0]] }),
  JSON.stringify({ rows: [{ i: 0, a: '2', r: 2, d: 2 }, rows[0]] })])('invalid output fails without inventing a match: %s', async text => {
  const f = fixture();
  const rejected = failure(evaluate(f)('query', candidates, new AbortController().signal), /fallback failed/);
  await until(() => f.calls.some(call => call.method === 'turn/start'));
  f.complete(text);
  await rejected;
  expect(f.stops()).toBe(1);
});

test('cancellation interrupts Luna, releases the client and preserves unknown token usage', async () => {
  const f = fixture(), controller = new AbortController(), usage = emptyRecallUsage();
  const rejected = failure(evaluate(f)('query', candidates, controller.signal, value => addRecallUsage(usage, value)), /user canceled/);
  await until(() => f.calls.some(call => call.method === 'turn/start'));
  controller.abort(new Error('user canceled'));
  await rejected;
  expect(f.calls.some(call => call.method === 'turn/interrupt')).toBe(true);
  expect(usage).toMatchObject({ requests: 0, estimatedCostUsd: 0, luna: { requests: 1, inputTokens: null, outputTokens: null } });
  expect(f.stops()).toBe(1);
});

test('timeout terminates the isolated client', async () => {
  const f = fixture();
  await failure(evaluate(f, 20)('query', candidates, new AbortController().signal), /fallback failed/);
  expect(f.calls.some(call => call.method === 'turn/interrupt')).toBe(true);
  expect(f.stops()).toBe(1);
});

test.each(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange'])('rejects unexpected tool activity: %s', async type => {
  const f = fixture();
  const rejected = failure(evaluate(f)('query', candidates, new AbortController().signal), /fallback failed/);
  await until(() => f.calls.some(call => call.method === 'turn/start'));
  f.notify('item/started', { threadId: 'recall', item: { type } });
  await rejected;
  expect(f.stops()).toBe(1);
});

test('API-key account cannot silently replace the requested subscription route', async () => {
  const f = fixture();
  f.handlers.set('account/read', async () => ({ account: { type: 'apiKey' } }));
  await failure(evaluate(f)('query', candidates, new AbortController().signal), /subscription/);
  expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
  expect(f.stops()).toBe(1);
});

test('pending setup respects an already aborted caller without creating a client', async () => {
  let created = 0;
  const f = fixture();
  const run = createLunaHistoryRecallEvaluator({ cwd: '/workspace', createClient: () => { created++; return f.client; } });
  await failure(run('query', candidates, AbortSignal.abort(new Error('stopped'))), /stopped/);
  expect(created).toBe(0);
});
