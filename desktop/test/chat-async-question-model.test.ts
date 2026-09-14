import { describe, expect, test } from 'bun:test';
import {
  INITIAL_CHAT_STATE,
  chatReducer,
  normalizeChatEvent,
  normalizeOpenSessionResponse,
  type ChatState,
} from '../frontend/src/features/chat/model';
import type { ChatAsyncQuestion } from '../shared/chat-async-question';

const questions: ChatAsyncQuestion[] = [
  { title: 'Where should dragging copy text?', options: ['Entire app', 'Chat only'] },
  { title: 'Any other preferences?', options: null },
];
const questionEvent = {
  type: 'assistant-questions', threadId: 'thread', itemId: 'message', questions, createdAt: 120,
};

function apply(state: ChatState, value: unknown): ChatState {
  const event = normalizeChatEvent(value);
  if (!event) throw new Error('Expected a valid chat event.');
  return chatReducer(state, { type: 'event', event });
}

function openedState(): ChatState {
  return { ...INITIAL_CHAT_STATE, activeSessionId: 'thread', phase: 'streaming' };
}

function history(items: unknown[]) {
  return normalizeOpenSessionResponse({
    session: { id: 'thread', title: 'Question', preview: '', createdAt: 100, updatedAt: 130, status: 'idle' },
    items,
    responseInProgress: false,
  });
}

describe('assistant questions in the chat model', () => {
  test('attaches selectable questions to an already streamed message without duplicating its text', () => {
    const streamed = apply(openedState(), {
      type: 'assistant-delta', threadId: 'thread', itemId: 'message', text: 'Choose a scope.', createdAt: 110,
    });
    const result = apply(streamed, questionEvent);
    expect(result.items).toEqual([
      { id: 'message', kind: 'assistant', text: 'Choose a scope.', createdAt: 110, questions },
    ]);
    expect(streamed.items[0]).not.toHaveProperty('questions');
  });

  test('creates a question-only assistant item and preserves its questions through subsequent deltas', () => {
    const pending = apply(openedState(), questionEvent);
    expect(pending.items).toEqual([
      { id: 'message', kind: 'assistant', text: '', createdAt: 120, questions },
    ]);
    const completed = apply(pending, {
      type: 'assistant-delta', threadId: 'thread', itemId: 'message', text: 'Choose a scope.', createdAt: 121,
    });
    expect(completed.items).toEqual([
      { id: 'message', kind: 'assistant', text: 'Choose a scope.', createdAt: 120, questions },
    ]);
  });

  test('does not attach questions to another thread or a reasoning item sharing the provider id', () => {
    const state = apply(openedState(), {
      type: 'reasoning-delta', threadId: 'thread', itemId: 'message', text: 'Thinking', createdAt: 110,
    });
    expect(apply(state, { ...questionEvent, threadId: 'another-thread' })).toBe(state);
    const result = apply(state, questionEvent);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(state.items[0]);
    expect(result.items[1]).toMatchObject({ kind: 'assistant', questions });
  });

  test('repeated metadata updates the same question message', () => {
    const first = apply(openedState(), questionEvent);
    const revised = [{ title: 'Updated question', options: ['One', 'Two'] }];
    const second = apply(first, { ...questionEvent, questions: revised });
    expect(second.items).toEqual([
      { id: 'message', kind: 'assistant', text: '', createdAt: 120, questions: revised },
    ]);
  });

  test('keeps both question-only and text-bearing questions when reopening history', () => {
    const response = history([
      { id: 'first', kind: 'assistant', text: '', questions, createdAt: 110 },
      { id: 'second', kind: 'assistant', text: 'Please choose.', questions, createdAt: 120 },
    ]);
    const result = chatReducer(openedState(), { type: 'session-opened', ...response });
    expect(result.items).toEqual([
      { id: 'first', kind: 'assistant', text: '', questions, createdAt: 110 },
      { id: 'second', kind: 'assistant', text: 'Please choose.', questions, createdAt: 120 },
    ]);
  });

  test('ignores question metadata on other history item kinds and keeps existing empty-text behavior', () => {
    const items = ['user', 'reasoning', 'plan'].flatMap(kind => [
      { id: `${kind}-text`, kind, text: 'Original text', questions, createdAt: 100 },
      { id: `${kind}-empty`, kind, text: '', questions, createdAt: 100 },
    ]);
    expect(history(items).items).toEqual((['user', 'reasoning', 'plan'] as const).map(kind => ({
      id: `${kind}-text`, kind, text: 'Original text', createdAt: 100,
    })));
  });

  test('rejects events with no valid question or missing message routing', () => {
    for (const invalid of [
      undefined, null, {}, [], [null], [{ title: ' ', options: null }],
      [{ title: 'Question', options: ['Yes', 42] }], [{ title: 'Question', options: 'Yes' }],
    ]) {
      expect(normalizeChatEvent({ ...questionEvent, questions: invalid })).toBeNull();
    }
    for (const route of [{ threadId: '' }, { itemId: '' }, { threadId: 123 }, { itemId: null }]) {
      expect(normalizeChatEvent({ ...questionEvent, ...route })).toBeNull();
    }
  });

  test('retains assistant text but discards malformed historical question metadata', () => {
    const malformed = [{ title: 'Question', options: { first: 'Yes' } }];
    expect(history([
      { id: 'text', kind: 'assistant', text: 'Existing text', questions: malformed, createdAt: 100 },
      { id: 'empty', kind: 'assistant', text: '', questions: malformed, createdAt: 100 },
    ]).items).toEqual([{ id: 'text', kind: 'assistant', text: 'Existing text', createdAt: 100 }]);
  });
});
