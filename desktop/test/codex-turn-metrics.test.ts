import { expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { readCodexTurnMetrics } from '../lib/codex-chat-turn-metrics.mts';
import { CodexTurnMetricsReader, TurnMetricsParser } from '../lib/codex-turn-metrics-reader.mts';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';
import { averageTurnTps } from '../shared/chat-turn-metrics.ts';
import { createFakeCodexClient } from './codex-chat-test-helpers.ts';

const usage = (output: number) => ({ input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0,
  output_tokens: output, reasoning_output_tokens: 100, total_tokens: 1000 + output });
const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
const metadata = record('session_meta', { id: 'root' });
const context = (turn_id: string, model = 'gpt-6-astra', effort = 'high') => record('turn_context', { turn_id, model, effort });
const tokens = (turn_id: string, output = 600, thread_id = 'root') => record('token_usage_record', {
  thread_id, turn_id, turn_token_usage: usage(output), thread_token_usage: usage(9999), usage: usage(200),
});
const complete = (turn_id: string) => record('event_msg', { type: 'task_complete', turn_id, duration_ms: 2000 });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function failure(operation: Promise<unknown>, message: string) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

test('turn totals replace snapshots without summing requests, thread totals, or subagent usage', () => {
  const parser = new TurnMetricsParser('root');
  for (const line of [metadata, context('a'), tokens('a', 300), tokens('a'), tokens('a'), tokens('a', 9999, 'child'),
    complete('a'), context('b', 'another-model', 'max'), tokens('b', 900)]) parser.accept(line);
  const a = parser.turns.get('a')!;
  expect(a).toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'high', usage: { outputTokens: 600, cachedInputTokens: 800 } });
  expect(parser.turns.get('b')).toMatchObject({ model: 'another-model', reasoningEffort: 'max', usage: { outputTokens: 900 } });
  expect(averageTurnTps(a)).toBe(300);
  expect(averageTurnTps({ ...a, durationMs: 0 })).toBeNull();
  expect(averageTurnTps({ ...a, usage: null })).toBeNull();
});

test('unidentified rollouts, missing and invalid metrics remain unavailable', () => {
  const parser = new TurnMetricsParser('root');
  parser.accept(tokens('a'));
  parser.accept(record('session_meta', { id: 'other' }));
  parser.accept(context('a'));
  expect(parser.turns.size).toBe(0);
  parser.accept(metadata);
  parser.accept(context('a'));
  parser.accept(record('token_usage_record', { thread_id: 'root', turn_id: 'a', turn_token_usage: { ...usage(600), output_tokens: -1 } }));
  parser.accept(record('event_msg', { type: 'task_complete', turn_id: 'a', duration_ms: -1 }));
  expect(parser.turns.get('a')).toMatchObject({ usage: null, durationMs: null });
  parser.accept(record('event_msg', { type: 'task_complete', turn_id: 'a', started_at: 10, completed_at: 13 }));
  expect(parser.turns.get('a')?.durationMs).toBe(3000);
});

test('bounded LF reading skips large records, preserves Unicode, refreshes appended records and survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-turn-metrics-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    const ending = complete('a');
    await writeFile(path, metadata + record('response_item', { content: 'x'.repeat(2 * 1024 * 1024) })
      + context('a', '한글\u2028model\u2029') + tokens('a') + ending.slice(0, -1));
    const reader = new CodexTurnMetricsReader();
    const first = await reader.read({ id: 'root', path });
    expect(first.get('a')).toMatchObject({ model: '한글\u2028model\u2029', durationMs: null, usage: { outputTokens: 600 } });
    expect(await reader.read({ id: 'root', path })).toBe(first);
    await appendFile(path, '\n');
    expect((await reader.read({ id: 'root', path })).get('a')?.durationMs).toBe(2000);
    expect((await new CodexTurnMetricsReader().read({ id: 'root', path })).get('a')?.durationMs).toBe(2000);
    expect((await reader.read({ id: 'wrong', path })).size).toBe(0);
    expect((await reader.read({ id: 'root', path: join(directory, 'missing.jsonl') })).size).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('metrics read the owning account and map completed responses without sending or using current model settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-turn-owner-'));
  const path = join(directory, 'rollout.jsonl');
  const client = createFakeCodexClient();
  const calls: unknown[] = [];
  const thread = { id: 'root', path, model: 'current-setting-must-not-replace-history', agentNickname: 'Primary', turns: [
    { id: 'a', status: 'completed', items: [{ id: 'answer', type: 'agentMessage' }, { id: 'tool', type: 'commandExecution' }] },
    { id: 'b', status: 'inProgress', items: [{ id: 'partial', type: 'agentMessage' }] },
    { id: 'old', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage' }] },
  ] };
  const service = new CodexChatService({ client, cwd: directory, serviceName: 'test', developerInstructions: 'Test', conversations: {
    async list() { return { sessions: [] }; }, async resolve(id) { return id; }, async locations() { return []; }, async forget() {},
    async request() { throw new Error('Wrong account path'); },
    async read(id, method, params) { calls.push({ id, method, params, account: 'owner' }); return { thread }; },
  } });
  service.viewedThreadId = 'root';
  try {
    await writeFile(path, metadata + context('a') + tokens('a') + complete('a'));
    const response = await readCodexTurnMetrics(service, 'root');
    expect(response.turns.map(turn => turn.itemIds)).toEqual([['answer'], ['old-answer']]);
    expect(response.turns[0]).toMatchObject({ agentName: 'Primary', model: 'gpt-6-astra', usage: { outputTokens: 600 } });
    expect(response.turns[1]).toMatchObject({ model: null, usage: null, durationMs: null });
    expect(calls).toEqual([{ id: 'root', method: 'thread/read', params: { includeTurns: true }, account: 'owner' }]);
    expect(client.requests).toHaveLength(0);
    await failure(readCodexTurnMetrics(service, 'unrelated'), 'conversation changed');
  } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a conversation switch rejects late statistics', async () => {
  const gate = createDeferred<unknown>();
  const client = createFakeCodexClient({ 'thread/read': () => gate.promise });
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test' });
  service.viewedThreadId = 'root';
  try {
    const pending = readCodexTurnMetrics(service, 'root');
    service.viewedThreadId = 'other';
    gate.resolve({ thread: { id: 'root', turns: [] } });
    await failure(pending, 'conversation changed');
  } finally { await service.stop(); }
});

test('turn metrics IPC rejects untrusted senders and uses the requested pane', async () => {
  type Options = Parameters<typeof registerCodexChatIpc>[0];
  type Handler = Parameters<Options['ipc']['handle']>[1];
  const handlers = new Map<string, Handler>();
  const client = createFakeCodexClient({ 'thread/read': { thread: { id: 'root', turns: [] } } });
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test' });
  service.viewedThreadId = 'root';
  let allowed = true;
  const panes: unknown[] = [];
  registerCodexChatIpc({
    ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    service(_event, pane) { panes.push(pane); return service; },
    assertSender() { if (!allowed) throw new Error('Untrusted sender'); },
    relays: {} as Options['relays'],
    savedTurns: { async list() { return []; }, async save() { throw new Error('Unused'); }, async delete() { return { id: '' }; } },
    async prepareMessage() { throw new Error('Must not send'); },
  });
  const event = {} as IpcMainInvokeEvent;
  try {
    const handler = handlers.get('cheshi:read-codex-turn-metrics')!;
    expect(await handler(event, 'root', 'pane-b')).toEqual({ threadId: 'root', turns: [] });
    expect(panes).toEqual(['pane-b']);
    allowed = false;
    expect(() => handler(event, 'root', 'pane-b')).toThrow('Untrusted sender');
    expect(panes).toHaveLength(1);
  } finally { await service.stop(); }
});
