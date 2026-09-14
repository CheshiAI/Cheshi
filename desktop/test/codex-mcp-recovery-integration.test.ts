import { expect, test } from 'bun:test';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers';

const inventory = (runtimeStatus: string) => ({ data: [{
  name: 'cheshi_codegraph', runtimeStatus, tools: { codegraph_explore: {} }, authStatus: 'unsupported', toolsError: null,
}], nextCursor: null });

function setup() {
  let connected = false;
  const client = createFakeCodexClient({
    'thread/resume': { thread: codexThread('main') },
    'mcpServerStatus/list': () => inventory(connected ? 'connected' : 'failed'),
    'config/mcpServer/reload': () => { connected = true; return {}; },
    'turn/start': { turn: { id: 'turn-1' } },
  });
  const service = createCodexChatService(client);
  service.viewedThreadId = 'main';
  service.subscribedThreadIds.add('main');
  return { client, service };
}

test('a send reconnects stale CodeGraph before starting the original instruction exactly once', async () => {
  const { client, service } = setup();
  try {
    await service.sendMessage('Continue my work', 'user-message');
    const methods = client.requests.map(request => request.method);
    const reload = methods.indexOf('config/mcpServer/reload');
    expect(reload).toBeGreaterThan(-1);
    expect(reload).toBeLessThan(methods.indexOf('turn/start'));
    expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(client.requests.find(request => request.method === 'turn/start')?.params).toMatchObject({
      threadId: 'main', clientUserMessageId: 'user-message', input: [{ type: 'text', text: 'Continue my work', text_elements: [] }],
    });
    expect(service.viewedThreadId).toBe('main');
  } finally { await service.stop(); }
});

test('the MCP menu returns refreshed live status instead of the cached tool inventory', async () => {
  const { client, service } = setup();
  try {
    const result = await service.listMcpServers();
    expect(result.servers[0]?.runtimeStatus).toBe('connected');
    expect(result.servers[0]?.connected).toBe(true);
    expect(client.requests.map(request => request.method)).toEqual([
      'mcpServerStatus/list', 'config/mcpServer/reload', 'mcpServerStatus/list',
    ]);
    expect(service.subscribedThreadIds.has('main')).toBe(true);
  } finally { await service.stop(); }
});

test('a tool transport error requests reconnection without replaying or interrupting the active turn', async () => {
  const { client, service } = setup();
  try {
    service.beginActiveTurn('main', 'user-message');
    client.emit('item/completed', { threadId: 'main', item: {
      type: 'mcpToolCall', id: 'failed-call', server: 'cheshi_codegraph', tool: 'codegraph_explore',
      status: 'failed', error: { message: 'Transport closed' }, result: null,
    } });
    await service.listMcpServers();
    expect(service.isThreadActive('main')).toBe(true);
    expect(client.requests.filter(request => request.method === 'config/mcpServer/reload')).toHaveLength(1);
    expect(client.requests.some(request => ['turn/start', 'turn/interrupt', 'thread/unsubscribe', 'thread/delete'].includes(request.method))).toBe(false);
  } finally { await service.stop(); }
});
