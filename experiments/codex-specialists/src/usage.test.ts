import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTurnUsage, readNativeTurnUsage } from './native-usage.ts';
import { mergeTurnUsage, parseTaskUsage } from './usage-contract.ts';
import { AgentStore } from './store.ts';
import { FakeClient } from './agent-test-client.ts';
import { SpecialistAgent } from './agent.ts';

const directories: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), 'cheshi-usage-')); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function row(response: string, turn = 'turn', input = 100, cached: number | null = 80) {
  return JSON.stringify({ type: 'token_usage_record', payload: { thread_id: 'thread', turn_id: turn, response_id: response,
    usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 5, total_tokens: input + 5 } } });
}
const tokens = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5, totalTokens: 105 };
const usage = { threadId: 'thread', turnId: 'turn', modelCalls: 1, tokens, threadTotals: tokens };

test('native response identities exclude other turns and deduplicate repeated usage records', () => {
  const source = [row('first'), row('first'), row('second', 'turn', 200), row('foreign', 'other', 900)].join('\n');
  expect(nativeTurnUsage(source, 'thread', 'turn')).toEqual({ modelCalls: 2,
    tokens: { inputTokens: 300, cachedInputTokens: 160, outputTokens: 10, totalTokens: 310 } });
  expect(nativeTurnUsage(source, 'different', 'turn')).toBeNull();
  expect(nativeTurnUsage(source, 'thread', 'missing')).toBeNull();
});

test('missing, malformed and conflicting telemetry stays unknown rather than zero', async () => {
  expect(nativeTurnUsage('', 'thread', 'turn')).toBeNull();
  expect(nativeTurnUsage(row('first') + '\n{"partial":', 'thread', 'turn')).toBeNull();
  expect(nativeTurnUsage([row('first'), row('first', 'turn', 101)].join('\n'), 'thread', 'turn')).toBeNull();
  expect(nativeTurnUsage(row('first', 'turn', -1), 'thread', 'turn')).toBeNull();
  expect(nativeTurnUsage(row('first', 'turn', 100, null), 'thread', 'turn')?.tokens.cachedInputTokens).toBeNull();
  expect(await readNativeTurnUsage(undefined, 'thread', 'turn')).toBeNull();
  expect(await readNativeTurnUsage(join(temporary(), 'absent.jsonl'), 'thread', 'turn')).toBeNull();
  expect(() => parseTaskUsage({ turns: [usage, usage] })).toThrow();
  expect(() => parseTaskUsage({ turns: [{ ...usage, modelCalls: -1 }] })).toThrow();
  expect(() => parseTaskUsage({ turns: [{ ...usage, tokens: { ...tokens, cachedInputTokens: 101 } }] })).toThrow();
});

test('repeated saves replace a turn, resumed turns append, and old stores load without fabricated usage', () => {
  const store = new AgentStore(temporary()); store.create('chat', 'Hello');
  expect(new AgentStore(store.directory).task('chat')?.usage).toBeUndefined();
  let value = mergeTurnUsage(undefined, usage);
  value = mergeTurnUsage(value, usage);
  value = mergeTurnUsage(value, { ...usage, turnId: 'resumed', modelCalls: null, tokens: null });
  store.update('chat', { usage: value });
  expect(new AgentStore(store.directory).task('chat')?.usage?.turns).toHaveLength(2);
  expect(parseTaskUsage(value)).toEqual(value);
});

test.each(['completed', 'failed', 'interrupted', 'disconnected'])('ordinary conversation persists usage through %s and reload without inference', async status => {
  const directory = temporary(), store = new AgentStore(directory), client = new FakeClient();
  client.threadPath = join(directory, 'native.jsonl');
  writeFileSync(client.threadPath, [row('a'), row('b')].join('\n') + '\n');
  client.onStart = async () => {
    client.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId: 'turn', tokenUsage: {
      total: { inputTokens: 900, cachedInputTokens: 700, outputTokens: 50, totalTokens: 950 },
    } } });
    if (status !== 'disconnected') client.complete(status);
    else setTimeout(() => client.disconnect(), 0);
    return { turn: { id: 'turn' } };
  };
  const agent = new SpecialistAgent({ client, store, profile: 'test', workspace: directory, configuration: {
    conversationProtocol: 1, decisionProtocol: 1, profileId: 'dev', accountId: 'fixture', role: 'development',
    token: 'a'.repeat(64), instructions: 'test', model: 'test-model', reasoningEffort: 'medium', serviceTier: null,
    permissions: { fileWrite: false, commandExecution: false },
  } });
  agent.submit('chat', 'Hello', { roomId: 'room', conversation: 'chat', automatic: true, goal: false, userText: 'Hello' });
  await agent.settled();
  const saved = new AgentStore(directory).task('chat')!;
  expect(saved.status).toBe(status === 'disconnected' ? 'unknown' : status);
  expect(saved.goal).toBeUndefined();
  expect(saved.usage?.turns).toEqual([{ ...usage, modelCalls: 2,
    tokens: { inputTokens: 200, cachedInputTokens: 160, outputTokens: 10, totalTokens: 210 },
    threadTotals: { inputTokens: 900, cachedInputTokens: 700, outputTokens: 50, totalTokens: 950 } }]);
  expect(JSON.parse(readFileSync(join(directory, 'artifacts/chat.json'), 'utf8')).usage).toEqual(saved.usage);
  expect(client.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
});
