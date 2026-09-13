import { expect, test } from 'bun:test';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

test('account reset starts a fresh conversation and keeps one functioning event subscription', async () => {
  let account = 'first';
  const client = createFakeCodexClient({
    'thread/start': () => ({ thread: codexThread(account) }),
    'turn/start': () => ({ turn: { id: `${account}-turn` } }),
  });
  const service = createCodexChatService(client);
  const events: Record<string, unknown>[] = [];
  service.onEvent(event => events.push(event));
  await service.sendMessage('First account', 'first-message');
  client.emit('turn/completed', { threadId: account, turn: { id: `${account}-turn`, status: 'completed', items: [] } });
  expect(service.activeTurns.size).toBe(0);
  expect(service.viewedThreadId).toBe('first');
  account = 'second';
  await service.resetForAccount();
  expect(service.viewedThreadId).toBeNull();
  events.length = 0;
  await service.sendMessage('Second account', 'second-message');
  client.emit('turn/completed', { threadId: account, turn: { id: `${account}-turn`, status: 'completed', items: [] } });
  expect(service.viewedThreadId).toBe('second');
  expect(events.filter(event => event.type === 'session-created')).toHaveLength(1);
  expect(events.filter(event => event.type === 'turn-completed')).toHaveLength(1);
  expect(client.requests.filter(request => request.method === 'thread/start')).toHaveLength(2);
  await service.stop();
});
