import { expect, test } from 'bun:test';
import { startDiscordSetup } from '../lib/discord-setup.mts';
import { DISCORD_SETUP_TOOL } from '../lib/discord-setup-tools.mts';
import { codexThread, createCodexChatService, createFakeCodexClient, expectFailure } from './codex-chat-test-helpers.ts';

function fixture(fail = false) {
  const calls: unknown[] = [];
  let closed = 0;
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('setup-thread') },
    'turn/start': fail ? new Error('start failed') : { turn: { id: 'turn' } } });
  const service = createCodexChatService(client);
  const browser = { async execute(value: unknown) { calls.push(value); return { status: 'ready' }; }, close() { closed++; } };
  const invoke = async (id: number, threadId = 'setup-thread') => {
    client.emitRequest(id, 'item/tool/call', { threadId, turnId: 'turn', callId: `call-${id}`, namespace: null,
      tool: DISCORD_SETUP_TOOL, arguments: { action: 'inspect' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    return client.responsesSent.at(-1)?.result as { success: boolean };
  };
  return { client, service, browser, calls, invoke, closed: () => closed };
}
test('setup registers real dynamic tools before thread creation and keeps English instructions', async () => {
  const f = fixture();
  try {
    expect(await startDiscordSetup(f.service, () => f.browser)).toBe('setup-thread');
    const request = f.client.requests.find(item => item.method === 'thread/start');
    expect(request?.params.dynamicTools).toMatchObject([{ type: 'function', name: DISCORD_SETUP_TOOL }]);
    const turn = f.client.requests.find(item => item.method === 'turn/start');
    expect(JSON.stringify(turn?.params.input)).toContain('Use English for all setup messages and progress');
    expect((await f.invoke(1)).success).toBe(true);
    expect(f.calls).toEqual([{ action: 'inspect' }]);
    expect((await f.invoke(1)).success).toBe(false);
    expect((await f.invoke(2, 'another-thread')).success).toBe(false);
    expect(f.calls).toHaveLength(1);
    const active = f.service.activeTurns.get('setup-thread')!;
    active.turnId = 'next-turn';
    expect((await f.invoke(4)).success).toBe(false);
    active.turnId = 'turn'; active.interruptRequested = true;
    expect((await f.invoke(5)).success).toBe(false);
    f.service.activeTurns.clear();
    expect((await f.invoke(3)).success).toBe(false);
  } finally { await f.service.stop(); }
  expect(f.closed()).toBe(1);
});
test('normal conversations have no setup tool and failed setup closes its browser', async () => {
  const normal = fixture();
  try {
    await normal.service.sendMessage('hello', 'id', null, [], null);
    expect(normal.client.requests.find(item => item.method === 'thread/start')?.params.dynamicTools).toBeUndefined();
    expect((await normal.invoke(1)).success).toBe(false);
  } finally { await normal.service.stop(); }
  const failed = fixture(true);
  try {
    let rejected = false;
    try { await startDiscordSetup(failed.service, () => failed.browser); } catch { rejected = true; }
    expect(rejected).toBe(true); expect(failed.closed()).toBe(1);
  } finally { await failed.service.stop(); }
});
test('missing automation fails before replacing a conversation', async () => {
  const f = fixture(); f.service.viewedThreadId = 'existing';
  try {
    await expectFailure(() => startDiscordSetup(f.service), 'Restart Cheshi to use the automated setup assistant.');
    expect(f.service.viewedThreadId).toBe('existing');
    expect(f.client.requests).toHaveLength(0);
  } finally { await f.service.stop(); }
});
