import { expect, test } from 'bun:test';
import { createSkillFlowJudge, type SkillFlowJudgment } from '../lib/skill-flow-judge.mts';
import { createSkillFlowLunaJudge, withSkillFlowFallback } from '../lib/skill-flow-fallback.mts';
import { createSkillFlowCodex } from '../lib/skill-flow-codex.mts';
import type { CodexChatClient, JsonObject } from '../lib/codex-chat-types.mts';
import { recordValue } from '../lib/codex-service-utils.mts';

const question = { state: '자료', condition: '충분한가?' };
const metadata = { model: 'test', inputTokens: null, outputTokens: null, elapsedMs: 1 };
const no: SkillFlowJudgment = { ...metadata, status: 'decided', value: false, choice: 'no' };

test.each(['yes', 'no'] as const)('a valid Jev %s never calls Luna', async choice => {
  let calls = 0;
  const primary = createSkillFlowJudge({ getKey: () => 'test', request: async () => Response.json({
    answers: { condition: { type: 'choice', choice, confidence: 0, probabilities: { yes: 0.5, no: 0.5 } } },
  }) });
  const result = await withSkillFlowFallback(primary, async () => { calls++; return no; })(question);
  expect(result).toMatchObject({ status: 'decided', choice, provider: 'jev' });
  expect(calls).toBe(0);
});

test.each([401, 402, 403, 408, 429, 500, 503])('HTTP %s triggers one fallback with both attempts recorded', async status => {
  let calls = 0;
  const primary = createSkillFlowJudge({ getKey: () => 'test', request: async () => new Response('', { status }) });
  const result = await withSkillFlowFallback(primary, async (input, signal) => {
    expect(input).toBe(question);
    expect(signal).toBeUndefined();
    calls++;
    return no;
  })(question);
  expect(result).toMatchObject({ value: false, choice: 'no', provider: 'luna', attempts: [
    { provider: 'jev', status: 'error', reason: 'http' }, { provider: 'luna', status: 'decided' },
  ] });
  expect(calls).toBe(1);
});

test.each(['canceled', 'invalid_input'] as const)('%s never triggers Luna', async reason => {
  let calls = 0;
  const result = await withSkillFlowFallback(async () => ({ ...metadata, status: 'error', value: null, choice: null, reason }),
    async () => { calls++; return no; })(question);
  expect(result.status).toBe('error');
  expect(calls).toBe(0);
});

test.each(['yes', 'no', 'invalid', true, null])('Luna output must contain an exact yes/no choice: %s', async choice => {
  const judge = createSkillFlowLunaJudge(async request => {
    expect(request.research).toBeUndefined();
    return { ...metadata, model: 'gpt-5.6-luna', text: JSON.stringify({ choice }), webSearches: 0 };
  });
  const result = await judge(question);
  expect(result.status).toBe(choice === 'yes' || choice === 'no' ? 'decided' : 'error');
  if (result.status === 'decided') expect(result.value).toBe(choice === 'yes');
  expect(result).not.toHaveProperty('text');
});

function fixture(options: { research?: boolean; tool?: string; account?: string } = {}) {
  const listeners = new Set<(value: JsonObject) => void>();
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let stops = 0;
  const notify = (method: string, params: JsonObject) => listeners.forEach(listener => listener({ method, params }));
  const client: CodexChatClient & { stop(): Promise<void> } = {
    async request(method, value) {
      const params = recordValue(value) ?? {};
      calls.push({ method, params });
      if (method === 'account/read') return { account: { type: options.account ?? 'chatgpt' } };
      if (method === 'config/read') return { config: { mcp_servers: { sample: { url: 'http://localhost' } } } };
      if (method === 'model/list') return { data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna',
        displayName: 'Luna', defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
      if (method === 'thread/start') return { thread: { id: 'skill', ephemeral: true }, model: 'gpt-5.6-luna', modelProvider: 'openai' };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          if (options.tool) notify('item/started', { threadId: 'skill', item: { type: options.tool } });
          if (options.research) notify('item/completed', { threadId: 'skill', item: { type: 'webSearch' } });
          notify('thread/tokenUsage/updated', { threadId: 'skill', tokenUsage: { total: { inputTokens: 12, outputTokens: 4 } } });
          notify('turn/completed', { threadId: 'skill', turn: { id: 'turn', status: 'completed',
            items: [{ id: 'answer', type: 'agentMessage', text: '{"choice":"yes"}' }] } });
        });
        return { turn: { id: 'turn' } };
      }
      return {};
    },
    async respond() {}, async stop() { stops++; },
    onNotification(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onRequest() { return () => {}; }, onDidFail() { return () => {}; },
  };
  return { client, calls, stops: () => stops, listeners };
}

test.each([false, true])('subscription session isolates tools and keeps low/default settings; research=%s', async research => {
  const f = fixture({ research });
  const run = createSkillFlowCodex({ cwd: '/workspace', createClient: () => f.client });
  const result = await run({ instructions: 'judge', input: 'state', schema: {}, research });
  expect(result).toMatchObject({ model: 'gpt-5.6-luna', inputTokens: 12, outputTokens: 4, webSearches: research ? 1 : 0 });
  expect(f.calls.find(call => call.method === 'thread/start')?.params).toMatchObject({
    model: 'gpt-5.6-luna', modelProvider: 'openai', ephemeral: true, sandbox: 'read-only',
    config: { mcp_servers: { sample: { enabled: false } }, 'features.shell_tool': false,
      'features.multi_agent': false, web_search: research ? 'live' : 'disabled' },
  });
  expect(f.calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ effort: 'low', serviceTier: 'default' });
  expect(f.stops()).toBe(1);
  expect(f.listeners.size).toBe(0);
});

test.each(['commandExecution', 'mcpToolCall', 'fileChange', 'dynamicToolCall'])('research rejects %s activity', async tool => {
  const f = fixture({ research: true, tool });
  let caught: unknown;
  try {
    await createSkillFlowCodex({ cwd: '/workspace', createClient: () => f.client })(
      { instructions: 'research', input: 'topic', schema: {}, research: true });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain('cannot use that tool');
  expect(f.stops()).toBe(1);
});

test('fallback failures remain errors and do not become no', async () => {
  const f = fixture({ account: 'apiKey' });
  const result = await createSkillFlowLunaJudge(createSkillFlowCodex({ cwd: '/workspace', createClient: () => f.client }))(question);
  expect(result).toMatchObject({ status: 'error', value: null, choice: null });
  expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
  expect(f.stops()).toBe(1);
});
