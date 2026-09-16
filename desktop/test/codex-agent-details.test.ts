import { expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAgentTokenUsage } from '../lib/codex-agent-token-usage.mts';
import { CodexChatService } from '../lib/codex-chat-service.mts';
import { agentActivityFromItem, normalizeAgentTokenUsage } from '../shared/chat-agent-details.ts';
import { activityFromItem } from '../lib/codex-chat-thread-data.mts';
import { codexThread, createFakeCodexClient } from './codex-chat-test-helpers.ts';
import type { JsonObject } from '../lib/codex-chat-types.mts';
import type { IpcMainInvokeEvent } from 'electron';
import { registerCodexChatIpc } from '../lib/codex-chat-ipc.mts';

const counters = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 40, totalTokens: 1100 };
const tokenRecord = (input: number, cached: number) => JSON.stringify({ type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached,
    output_tokens: 100, reasoning_output_tokens: 40, total_tokens: input + 100 } },
} }) + '\n';

async function failure(operation: Promise<unknown>, message: string) {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

test('agent activities retain structured targets, requested configuration and task across history conversion', () => {
  const activity = activityFromItem({ type: 'collabAgentToolCall', id: 'call', tool: 'spawnAgent',
    receiverThreadIds: ['child', 'child'], prompt: 'Commit the reviewed changes.', model: 'gpt-5.6-luna',
    reasoningEffort: 'max', status: 'completed' }, 'completed', 'fallback');
  expect(activity?.agent).toEqual({ threadIds: ['child'], tool: 'spawnAgent', prompt: 'Commit the reviewed changes.',
    model: 'gpt-5.6-luna', reasoningEffort: 'max', agentPath: null });
  expect(activityFromItem({ type: 'subAgentActivity', id: 'activity', agentThreadId: 'child', agentPath: '/root/worker', kind: 'spawned' }, 'completed', 'fallback')?.agent)
    .toMatchObject({ threadIds: ['child'], agentPath: '/root/worker' });
  expect(agentActivityFromItem({ receiverThreadIds: [null, 42, ''], prompt: 'No id' }).threadIds).toEqual([]);
});

test('usage preserves unknown counters and rejects invalid numbers instead of claiming zero cache reuse', () => {
  expect(normalizeAgentTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
    .toMatchObject({ cachedInputTokens: null, reasoningOutputTokens: null, cacheWriteInputTokens: null });
  expect(normalizeAgentTokenUsage({ ...counters, cachedInputTokens: 0 })?.cachedInputTokens).toBe(0);
  expect(normalizeAgentTokenUsage({ ...counters, cachedInputTokens: 1001 })?.cachedInputTokens).toBeNull();
  for (const inputTokens of [-1, NaN, Infinity, '1000', 1.5]) expect(normalizeAgentTokenUsage({ ...counters, inputTokens })).toBeNull();
});

test('stored usage survives reopening, uses the latest cumulative snapshot and ignores incomplete records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-agent-usage-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'child' } }) + '\n'
      + tokenRecord(1000, 800) + tokenRecord(2000, 1600) + tokenRecord(2000, 1600) + '{"type":');
    const store = new CodexAgentTokenUsage();
    expect(await store.read({ id: 'child', path })).toMatchObject({ inputTokens: 2000, cachedInputTokens: 1600 });
    expect(await new CodexAgentTokenUsage().read({ id: 'child', path })).toMatchObject({ inputTokens: 2000 });
    expect(await store.read({ id: 'unrelated', path })).toBeNull();
    store.capture({ method: 'thread/tokenUsage/updated', params: { threadId: 'child', tokenUsage: { total: counters } } });
    expect((await store.read({ id: 'child', path }))?.inputTokens).toBe(2000);
    await appendFile(path, '\n' + 'x'.repeat(1024 * 1024 + 100) + '\n' + tokenRecord(3000, 2400));
    expect((await store.read({ id: 'child', path }))?.inputTokens).toBe(3000);
    expect(await store.read({ id: 'missing', path: join(directory, 'missing.jsonl') })).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live token notifications replace repeated totals and do not require an active viewed turn', async () => {
  const client = createFakeCodexClient();
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test' });
  try {
    for (let index = 0; index < 2; index++) client.emit('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: { total: counters } });
    expect(await service.agentTokenUsage.read({ id: 'child' })).toMatchObject(counters);
    expect(await service.agentTokenUsage.read({ id: 'other' })).toBeNull();
  } finally { await service.stop(); }
  expect(await service.agentTokenUsage.read({ id: 'child' })).toBeNull();
});

function fixture() {
  const root = codexThread('root', { cwd: '/workspace' });
  const child = codexThread('child', { parentThreadId: 'root', cwd: '/workspace', model: 'gpt-5.6-luna', reasoningEffort: 'max',
    turns: [{ id: 'turn', items: [{ id: 'command', type: 'commandExecution', command: 'git status',
      status: 'completed', aggregatedOutput: 'clean', exitCode: 0 }] }] });
  const client = createFakeCodexClient({
    'thread/read': (params: JsonObject) => ({ thread: params.threadId === 'root' ? root : child }),
    'thread/list': { data: [child] },
  });
  const service = new CodexChatService({ client, cwd: '/workspace', serviceName: 'test', developerInstructions: 'Test' });
  service.viewedThreadId = 'root';
  return { service, client };
}

test('details expose command results without selecting, resuming or sending to the agent', async () => {
  const { service, client } = fixture();
  try {
    const result = await service.readAgentDetails('root', ['child']);
    expect(result.agents[0]).toMatchObject({ id: 'child', model: 'gpt-5.6-luna', reasoningEffort: 'max', usage: null,
      items: [{ activity: 'command', detail: 'git status', output: 'clean', exitCode: 0 }] });
    expect(service.viewedThreadId).toBe('root');
    expect(client.requests.every(call => call.method === 'thread/read' || call.method === 'thread/list')).toBe(true);
    await failure(service.readAgentDetails('root', ['outside']), 'does not belong');
    expect(client.requests.some(call => call.params.threadId === 'outside')).toBe(false);
    await failure(service.readAgentDetails('previous', ['child']), 'conversation changed');
    await failure(service.readAgentDetails('root', []), 'between 1 and 32');
  } finally { await service.stop(); }
});

test('agent details IPC checks the sender and routes reads to the requested pane', async () => {
  type Options = Parameters<typeof registerCodexChatIpc>[0];
  type Handler = Parameters<Options['ipc']['handle']>[1];
  const handlers = new Map<string, Handler>();
  const calls: unknown[][] = [];
  let allowed = true;
  const options: Options = {
    ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    assertSender() { if (!allowed) throw new Error('Untrusted sender'); },
    service(_event: IpcMainInvokeEvent, contextId: unknown) {
      calls.push(['pane', contextId]);
      // This injected boundary only exposes the read operation exercised here.
      return { async readAgentDetails(threadId: unknown, ids: unknown) {
        calls.push(['read', threadId, ids]);
        return { agents: [] };
      } } as unknown as ReturnType<Options['service']>;
    },
    relays: {} as Options['relays'],
    savedTurns: { async list() { return []; }, async save() { throw new Error('Unused'); }, async delete() { return { id: '' }; } },
    async prepareMessage() { throw new Error('Reading details must not send a message'); },
  };
  registerCodexChatIpc(options);
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  const read = handlers.get('cheshi:read-codex-agent-details')!;
  expect(await read(event, 'root', ['child'], 'pane-b')).toEqual({ agents: [] });
  expect(calls).toEqual([['pane', 'pane-b'], ['read', 'root', ['child']]]);
  allowed = false;
  expect(() => read(event, 'root', ['child'], 'pane-b')).toThrow('Untrusted sender');
  expect(calls).toHaveLength(2);
});
