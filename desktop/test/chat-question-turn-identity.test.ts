import { expect, test } from 'bun:test';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { INITIAL_CHAT_STATE, chatReducer, normalizeChatEvent, normalizeOpenSessionResponse } from '../frontend/src/features/chat/model';
import type { ChatState } from '../frontend/src/features/chat/model';
import { fallbackQuestionRequest } from '../frontend/src/features/chat/chatQuestionChoices';
import { questionDismissal } from '../shared/chat-question-dismissals';

const text = '어떤 과일을 고르시겠어요?\n\n- 사과\n- 딸기';
const notice = '질문 카드에서 사과 또는 딸기를 선택해주세요.';
const session = { id: 'thread', title: 'Fruits', preview: '', createdAt: 1, updatedAt: 2, status: 'idle' };

test('live events and restored history produce the same thread, turn, and question identity', () => {
  let state: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread' };
  for (const [itemId, message] of [['q', text], ['notice', notice]]) {
    const event = normalizeChatEvent({ type: 'assistant-delta', threadId: 'thread', turnId: 'turn', itemId, text: message });
    expect(event).not.toBeNull();
    state = chatReducer(state, { type: 'event', event: event! });
  }
  const live = fallbackQuestionRequest(state.items, 'thread');
  const history = timelineFromThread({ id: 'thread', turns: [{ id: 'turn', items: [
    { type: 'agentMessage', id: 'q', text }, { type: 'agentMessage', id: 'notice', text: notice },
  ] }] });
  const restored = normalizeOpenSessionResponse({ session, items: history });
  expect(fallbackQuestionRequest(restored.items, 'thread')).toEqual(live);
  expect(live).toMatchObject({ turnId: 'turn', sourceItemId: 'q', id: 'question:["thread","turn","q"]' });
});

test('later deltas without metadata retain the known turn id and activities preserve turn boundaries', () => {
  let state: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread' };
  for (const value of [
    { type: 'assistant-delta', threadId: 'thread', turnId: 'turn', itemId: 'q', text: 'Which fruit?' },
    { type: 'assistant-delta', threadId: 'thread', itemId: 'q', text: '\n\n- Apple\n- Strawberry' },
    { type: 'activity', threadId: 'thread', turnId: 'next', item: { id: 'tool', kind: 'activity', label: 'Tool' } },
  ]) {
    state = chatReducer(state, { type: 'event', event: normalizeChatEvent(value)! });
  }
  expect(state.items[0]?.turnId).toBe('turn');
  expect(state.items[1]?.turnId).toBe('next');
  expect(fallbackQuestionRequest(state.items, 'thread')).toBeNull();
});

test('missing or invalid provider turn ids do not become invented persistent turn identities', () => {
  const history = timelineFromThread({ turns: [{ items: [{ id: 'q', type: 'agentMessage', text }] }] });
  const restored = normalizeOpenSessionResponse({ session, items: history });
  expect(fallbackQuestionRequest(restored.items, 'thread')).toMatchObject({ turnId: null, id: 'question:thread:q' });
  const event = normalizeChatEvent({ type: 'assistant-delta', threadId: 'thread', turnId: 12, itemId: 'q', text });
  expect(event).not.toHaveProperty('turnId');
});

test('persistent record validation retains complete source identities and rejects partial or malformed metadata', () => {
  const record = { questionId: 'q', action: 'skip' as const, turnId: 'turn', itemId: 'item' };
  expect(questionDismissal(record)).toEqual(record);
  expect(questionDismissal({ questionId: 'legacy', action: 'skip' })).toEqual({ questionId: 'legacy', action: 'skip' });
  for (const source of [{ turnId: 'turn' }, { itemId: 'item' }, { turnId: 1, itemId: 'item' }, { turnId: 'turn', itemId: '' }]) {
    expect(() => questionDismissal({ questionId: 'q', action: 'skip', ...source })).toThrow('source identity');
  }
});
