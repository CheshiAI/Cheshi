import { describe, expect, test } from 'bun:test';
import { compileChatHistoryThread } from '../lib/chat-history-compiler.mts';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { chatReducer, INITIAL_CHAT_STATE, normalizeChatEvent, normalizeOpenSessionResponse,
  type ChatState } from '../frontend/src/features/chat/model';
import { chatHistoryItemMatches } from '../frontend/src/features/chat/chatHistorySearchNavigation';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers';

const threadId = 'thread';
const turnId = 'turn';
function userItem(clientId: string | null, id: string) {
  return { type: 'userMessage', id, clientId, content: [{ type: 'text', text: 'Same prompt' }] };
}
function addOptimistic(state: ChatState, clientId: string): ChatState {
  return chatReducer(state, { type: 'optimistic-user', id: `client:${clientId}`, text: 'Same prompt',
    title: 'Same prompt', createdAt: 1 });
}
function identityFixture() {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread(threadId) },
    'turn/start': (params: Record<string, unknown>) => {
      client.emit('item/started', { threadId, turnId, item: userItem(String(params.clientUserMessageId), 'provider-first') });
      return { turn: { id: turnId } };
    },
    'turn/steer': { turnId },
  });
  const service = createCodexChatService(client);
  let state: ChatState = addOptimistic(INITIAL_CHAT_STATE, 'first');
  service.onEvent(value => {
    const event = normalizeChatEvent(value);
    if (event) state = chatReducer(state, { type: 'event', event });
  });
  return { service, client, get: () => state, set: (next: ChatState) => { state = next; } };
}

describe('live user message identity', () => {
  test('a just-completed live prompt matches its persisted search source before reopening', async () => {
    const f = identityFixture();
    try {
      await f.service.sendMessage('Same prompt', 'first');
      const liveItem = f.get().items[0];
      expect(liveItem).toMatchObject({ id: 'client:first', providerItemId: 'provider-first' });
      f.client.emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      const persisted = { ...codexThread(threadId), turns: [{ id: turnId, status: 'completed', items: [userItem('first', 'provider-first')] }] };
      const [hit] = compileChatHistoryThread(persisted, '/workspace/cheshi').entries;
      expect(hit?.itemId).toBe('provider-first');
      expect(f.get().items.filter(item => chatHistoryItemMatches(item, hit!.itemId))).toEqual([f.get().items[0]!]);
      expect(f.get().phase).toBe('idle');
      expect(f.client.requests.some(request => request.method === 'thread/resume')).toBe(false);
      const reopened = normalizeOpenSessionResponse({ session: { id: threadId, title: 'Same prompt', status: 'idle',
        preview: '', createdAt: 1, updatedAt: 2 }, items: timelineFromThread(persisted) });
      expect(chatHistoryItemMatches(reopened.items[0]!, hit!.itemId)).toBe(true);
    } finally { f.service.stop(); }
  });

  test('identical steering prompts match their echoed client id even when notifications arrive out of order', async () => {
    const f = identityFixture();
    try {
      await f.service.sendMessage('Same prompt', 'first');
      for (const clientId of ['second', 'third']) {
        f.set(addOptimistic(f.get(), clientId));
        await f.service.steerMessage('Same prompt', clientId);
      }
      const originalFirst = f.get().items[0];
      for (const [clientId, id] of [['third', 'provider-third'], ['second', 'provider-second']]) {
        for (const method of ['item/completed', 'item/started', 'item/completed']) {
          f.client.emit(method, { threadId, turnId, item: userItem(clientId!, id!) });
        }
      }
      expect(f.get().items.map(item => [item.id, item.kind === 'user' ? item.providerItemId : undefined])).toEqual([
        ['client:first', 'provider-first'], ['client:second', 'provider-second'], ['client:third', 'provider-third'],
      ]);
      expect(f.get().items[0]).toBe(originalFirst);
      expect(f.get().phase).toBe('streaming');
      expect(f.get().responseThreadIds).toEqual([threadId]);
      const before = f.get();
      f.client.emit('item/completed', { threadId, turnId, item: userItem('second', 'provider-second') });
      expect(f.get()).toBe(before);
    } finally { f.service.stop(); }
  });

  test('unassociated, conflicting and stale provider items never match a prompt by its text', async () => {
    const f = identityFixture();
    try {
      await f.service.sendMessage('Same prompt', 'first');
      f.set(addOptimistic(f.get(), 'second'));
      const before = f.get();
      for (const params of [
        { threadId, turnId, item: userItem(null, 'provider-only') },
        { threadId, turnId, item: userItem('unknown', 'provider-unknown') },
        { threadId, turnId, item: userItem('second', 'provider-first') },
        { threadId, turnId, item: userItem('first', 'provider-conflict') },
        { threadId, turnId: 'old-turn', item: userItem('second', 'provider-stale') },
        { threadId: 'other-thread', turnId, item: userItem('second', 'provider-other') },
      ]) f.client.emit('item/started', params);
      expect(f.get()).toBe(before);
      const missing = normalizeChatEvent({ type: 'user-message-identified', threadId, itemId: 'missing' });
      expect(missing).toBeNull();
    } finally { f.service.stop(); }
  });

  test('a late relay echo preserves identity and a send acknowledgement keeps the stable client key', () => {
    const initial = addOptimistic({ ...INITIAL_CHAT_STATE, activeSessionId: threadId }, 'first');
    const identified = chatReducer(initial, { type: 'event', event: {
      type: 'user-message-identified', threadId, clientMessageId: 'first', itemId: 'provider-first',
    } });
    const echoed = chatReducer(identified, { type: 'event', event: {
      type: 'user-message', threadId, clientMessageId: 'first', text: 'Echoed prompt', createdAt: 2,
    } });
    const accepted = chatReducer(echoed, { type: 'send-accepted', clientMessageId: 'first' });
    expect(accepted.items).toHaveLength(1);
    expect(accepted.items[0]).toMatchObject({ id: 'client:first', providerItemId: 'provider-first', pending: false });
  });

  test('provider-only history stays addressable and incomplete identity notifications are rejected', () => {
    const persisted = { ...codexThread(threadId), turns: [{ id: turnId, status: 'completed',
      items: [userItem(null, 'external-user')] }] };
    const reopened = normalizeOpenSessionResponse({ session: { id: threadId, title: 'External conversation',
      preview: '', status: 'idle', createdAt: 1, updatedAt: 2 }, items: timelineFromThread(persisted) });
    const entry = compileChatHistoryThread(persisted, '/workspace/cheshi').entries[0]!;
    expect(chatHistoryItemMatches(reopened.items[0]!, entry.itemId)).toBe(true);
    for (const field of ['threadId', 'clientMessageId', 'itemId']) {
      for (const value of ['', null, 1]) {
        expect(normalizeChatEvent({ type: 'user-message-identified', threadId,
          clientMessageId: 'first', itemId: 'provider-first', [field]: value })).toBeNull();
      }
    }
  });
});
