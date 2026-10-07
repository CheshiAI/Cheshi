import { expect, test } from 'bun:test';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { armDiscordSetup } from '../lib/discord-setup-tools.mts';
import { memoryArguments } from '../lib/flash/tools.mts';
import { createFakeCodexClient, codexThread } from './codex-chat-test-helpers.ts';
import { deferred } from './flash-test-helpers.ts';

test('session start merges Flash and Discord tools; calls are bound to the active turn', async () => {
  const calls: unknown[] = [];
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('session') }, 'turn/start': { turn: { id: 'turn' } } });
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'cheshi', developerInstructions: 'Instructions',
    memory: { execute: async (...args) => { calls.push(args.slice(0, 3)); return { matches: [] }; } } });
  armDiscordSetup(service, { execute: async () => ({}), close: () => {} });
  try {
    await service.sendMessage('hello', 'message', null, [], null);
    const start = client.requests.find(item => item.method === 'thread/start')!;
    expect(start.params.dynamicTools).toMatchObject([
      { name: 'cheshi_discord_setup' }, { name: 'memory_search' }, { name: 'memory_read' },
    ]);
    const invoke = async (id: number, changes: Record<string, unknown> = {}) => {
      client.emitRequest(id, 'item/tool/call', { tool: 'memory_search', threadId: 'session', turnId: 'turn',
        callId: `call-${id}`, arguments: { query: 'Past decision?' }, ...changes });
      await new Promise(resolve => setTimeout(resolve, 0));
      return client.responsesSent.at(-1)?.result as { success: boolean };
    };
    expect((await invoke(1)).success).toBe(true);
    expect(calls).toEqual([['memory_search', { query: 'Past decision?' }, 'session']]);
    expect((await invoke(1)).success).toBe(false);
    expect((await invoke(2, { threadId: 'foreign-session' })).success).toBe(false);
    expect((await invoke(3, { turnId: 'old-turn' })).success).toBe(false);
    expect((await invoke(4, { arguments: { query: 'q', account: 'other' } })).success).toBe(false);
    expect((await invoke(5, { namespace: 'other' })).success).toBe(false);
    expect(calls).toHaveLength(1);
  } finally { await service.stop(); }
});

test('pane stop aborts pending memory and never emits a successful late result', async () => {
  const started = deferred<AbortSignal>(); const finish = deferred<unknown>();
  const client = createFakeCodexClient();
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'cheshi', developerInstructions: 'Instructions',
    memory: { execute: async (_method, _params, _session, signal) => { started.resolve(signal); return finish.promise; } } });
  const active = service.beginActiveTurn('session', 'message'); active.turnId = 'turn';
  client.emitRequest(1, 'item/tool/call', { tool: 'memory_read', threadId: 'session', turnId: 'turn', callId: 'call', arguments: { source_id: 'source' } });
  const signal = await started.promise;
  await service.stop();
  expect(signal.aborted).toBe(true);
  finish.resolve({ text: 'late private data' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(client.responsesSent[0]?.result).toMatchObject({ success: false });
  expect(JSON.stringify(client.responsesSent)).not.toContain('late private data');
});

test('memory argument validation rejects unknown scope, boolean limits and invalid ranges', () => {
  for (const arguments_ of [{ query: 'q', limit: true }, { query: '' }, { query: 'q', workspace: '/' }, { query: 'q', limit: 31 }]) {
    expect(() => memoryArguments('memory_search', arguments_)).toThrow();
  }
  expect(() => memoryArguments('memory_read', { source_id: 'id', offset: -1 })).toThrow();
  expect(memoryArguments('memory_read', { source_id: 'id', offset: 2, after: 3 })).toEqual({ source_id: 'id', offset: 2, after: 3 });
});
