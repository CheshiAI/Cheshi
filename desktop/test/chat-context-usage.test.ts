import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextUsageFromNotification, contextUsagePercent, normalizeChatContextUsage,
} from '../shared/chat-context-usage.ts';
import { CodexAgentTokenUsage } from '../lib/codex-agent-token-usage.mts';
import { INITIAL_CHAT_STATE, chatReducer, normalizeChatEvent } from '../frontend/src/features/chat/model.ts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

const total = { totalTokens: 900_000, inputTokens: 800_000, outputTokens: 100_000 };
const notification = (usedTokens: number, contextWindow: number | null = 200_000) => ({
  total, last: { totalTokens: usedTokens }, modelContextWindow: contextWindow,
});

test('context percentage uses the latest request, includes zero, and never guesses an unknown window', () => {
  const usage = contextUsageFromNotification(notification(84_000));
  expect(usage).toEqual({ usedTokens: 84_000, contextWindow: 200_000 });
  expect(contextUsagePercent(usage)).toBe(42);
  expect(contextUsagePercent(contextUsageFromNotification(notification(0)))).toBe(0);
  expect(contextUsagePercent(contextUsageFromNotification(notification(300_000)))).toBe(100);
  for (const contextWindow of [null, 0, -1, Infinity, '200000', 0.5]) {
    const unknown = normalizeChatContextUsage({ usedTokens: 100, contextWindow });
    expect(unknown?.contextWindow).toBeNull();
    expect(contextUsagePercent(unknown)).toBeNull();
  }
  for (const usedTokens of [-1, NaN, Infinity, '100', 1.5]) {
    expect(normalizeChatContextUsage({ usedTokens, contextWindow: 200_000 })).toBeNull();
  }
  expect(contextUsageFromNotification({ total, modelContextWindow: 200_000 })).toBeNull();
});

test('reducer keeps pane session values separate and replaces usage after compaction', () => {
  let state = INITIAL_CHAT_STATE;
  const accept = (threadId: string, usedTokens: number) => {
    const event = normalizeChatEvent({ type: 'context-usage', threadId, usage: { usedTokens, contextWindow: 200_000 } });
    if (!event) throw new Error('Expected a context event');
    state = chatReducer(state, { type: 'event', event });
  };
  accept('first', 150_000);
  accept('second', 84_000);
  state = chatReducer(state, { type: 'event', event: { type: 'session-selected', threadId: 'first' } });
  expect(contextUsagePercent(state.contextUsageByThread[state.activeSessionId!])).toBe(75);
  accept('first', 20_000);
  expect(contextUsagePercent(state.contextUsageByThread.first)).toBe(10);
  state = chatReducer(state, { type: 'event', event: { type: 'session-selected', threadId: 'second' } });
  expect(contextUsagePercent(state.contextUsageByThread[state.activeSessionId!])).toBe(42);
  state = chatReducer(state, { type: 'new-session' });
  expect(state.activeSessionId).toBeNull();
  state = chatReducer(state, { type: 'event', event: { type: 'sessions-deleted', threadIds: ['first'] } });
  expect(state.contextUsageByThread.first).toBeUndefined();
  expect(state.contextUsageByThread.second?.usedTokens).toBe(84_000);
  expect(normalizeChatEvent({ type: 'context-usage', threadId: 'second', usage: { usedTokens: -1 } })).toBeNull();
  const cleared = normalizeChatEvent({ type: 'context-usage', threadId: 'second', usage: null });
  if (!cleared) throw new Error('Expected an unavailable context event');
  state = chatReducer(state, { type: 'event', event: cleared });
  expect(state.contextUsageByThread.second).toBeNull();
});

test('rollout context is restored with identity checks and replaced by lower live context after compaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-context-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    await writeFile(path, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'first' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { total_tokens: 900_000, input_tokens: 800_000, output_tokens: 100_000 },
        last_token_usage: { total_tokens: 84_000 }, model_context_window: 200_000,
      } } }),
      '{"partial":',
    ].join('\n'));
    const store = new CodexAgentTokenUsage();
    expect(await store.readContext({ id: 'first', path })).toEqual({ usedTokens: 84_000, contextWindow: 200_000 });
    expect(await store.readContext({ id: 'other', path })).toBeNull();
    store.capture({ method: 'thread/tokenUsage/updated', params: { threadId: 'first', tokenUsage: notification(20_000) } });
    expect(await store.readContext({ id: 'first', path })).toEqual({ usedTokens: 20_000, contextWindow: 200_000 });
    expect((await store.read({ id: 'first', path }))?.totalTokens).toBe(900_000);
    store.clear();
    expect(await store.readContext({ id: 'first' })).toBeNull();
    expect(await store.readContext({ id: 'first', path })).toEqual({ usedTokens: 84_000, contextWindow: 200_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opening an idle session replays its context and live updates do not require an active turn', async () => {
  const client = createFakeCodexClient({
    'thread/read': ({ threadId }: { threadId: string }) => ({ thread: codexThread(threadId) }),
  });
  const service = createCodexChatService(client);
  const events: Record<string, unknown>[] = [];
  const unsubscribe = service.onEvent(event => events.push(event));
  try {
    client.emit('thread/tokenUsage/updated', { threadId: 'first', tokenUsage: notification(84_000) });
    await service.openSession('first');
    expect(events.filter(event => event.type === 'context-usage').at(-1))
      .toEqual({ type: 'context-usage', threadId: 'first', usage: { usedTokens: 84_000, contextWindow: 200_000 } });
    client.emit('thread/tokenUsage/updated', { threadId: 'first', tokenUsage: notification(20_000) });
    expect(events.at(-1)).toEqual({ type: 'context-usage', threadId: 'first',
      usage: { usedTokens: 20_000, contextWindow: 200_000 } });
    client.emit('thread/tokenUsage/updated', { threadId: 'other', tokenUsage: notification(50_000) });
    expect(events.at(-1)?.threadId).toBe('first');
    await service.openSession('unknown');
    expect(events.filter(event => event.type === 'context-usage').at(-1))
      .toEqual({ type: 'context-usage', threadId: 'unknown', usage: null });
  } finally {
    unsubscribe();
    await service.stop();
  }
});
