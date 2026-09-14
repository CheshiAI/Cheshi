import { expect, test } from 'bun:test';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { normalizeChatAsyncQuestions } from '../shared/chat-async-question.ts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

const questions = [{ title: 'Which scope?', options: ['All text', 'Chat only'] }];

async function fixture() {
  const client = createFakeCodexClient({
    'thread/start': { thread: codexThread('thread') },
    'turn/start': { turn: { id: 'turn' } },
  });
  const service = createCodexChatService(client);
  const events: Record<string, unknown>[] = [];
  service.onEvent(event => events.push(event));
  await service.sendMessage('Enable automatic copying', 'user-message');
  events.length = 0;
  return { client, service, events };
}

function completedMessage(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread', turnId: 'turn',
    item: { type: 'agentMessage', id: 'message', text: 'Which scope?', questions },
    ...overrides,
  };
}

test('emits selectable questions after streamed text without duplicating its text', async () => {
  const { client, service, events } = await fixture();
  try {
    client.emit('item/agentMessage/delta', {
      threadId: 'thread', turnId: 'turn', itemId: 'message', text: undefined, delta: 'Which scope?',
    });
    client.emit('item/completed', completedMessage());
    expect(events).toEqual([
      { type: 'assistant-delta', threadId: 'thread', turnId: 'turn', itemId: 'message', text: 'Which scope?' },
      { type: 'assistant-questions', threadId: 'thread', turnId: 'turn', itemId: 'message', questions },
    ]);
  } finally {
    service.stop();
  }
});

test('emits final text and questions when no text delta was streamed', async () => {
  const { client, service, events } = await fixture();
  try {
    client.emit('item/completed', completedMessage());
    expect(events).toEqual([
      { type: 'assistant-delta', threadId: 'thread', turnId: 'turn', itemId: 'message', text: 'Which scope?' },
      { type: 'assistant-questions', threadId: 'thread', turnId: 'turn', itemId: 'message', questions },
    ]);
  } finally {
    service.stop();
  }
});

test('preserves questions without text and ignores missing or malformed question metadata', async () => {
  const { client, service, events } = await fixture();
  try {
    client.emit('item/completed', completedMessage({
      item: { type: 'agentMessage', id: 'question-only', text: '', questions },
    }));
    for (const metadata of [undefined, null, [], {}, [{ title: true, options: ['A'] }]]) {
      client.emit('item/completed', completedMessage({
        item: { type: 'agentMessage', id: 'invalid', text: '', questions: metadata },
      }));
    }
    expect(events).toEqual([
      { type: 'assistant-questions', threadId: 'thread', turnId: 'turn', itemId: 'question-only', questions },
    ]);
  } finally {
    service.stop();
  }
});

test('ignores questions for other turns, background threads and incomplete messages', async () => {
  const { client, service, events } = await fixture();
  try {
    client.emit('item/started', completedMessage());
    client.emit('item/completed', completedMessage({ turnId: 'another-turn' }));
    client.emit('item/completed', completedMessage({ threadId: 'another-thread' }));
    service.viewedThreadId = 'another-thread';
    client.emit('item/completed', completedMessage());
    expect(events).toEqual([]);
  } finally {
    service.stop();
  }
});

test('history keeps questions on assistant messages, including messages containing no text', () => {
  const timeline = timelineFromThread({ thread: codexThread('thread', {
    turns: [{ id: 'turn', startedAt: 100, completedAt: 120, items: [
      { id: 'first', type: 'agentMessage', text: 'Which scope?', questions },
      { id: 'second', type: 'agentMessage', text: '', questions: [{ title: 'Explain your preference', options: null }] },
      { id: 'third', type: 'agentMessage', text: 'Normal message', questions: null },
      { id: 'empty', type: 'agentMessage', text: '', questions: [{ title: 3, options: null }] },
    ] }],
  }) });
  expect(timeline).toEqual([
    { id: 'first', kind: 'assistant', text: 'Which scope?', questions, createdAt: 120 },
    { id: 'second', kind: 'assistant', text: '', questions: [{ title: 'Explain your preference', options: null }], createdAt: 120 },
    { id: 'third', kind: 'assistant', text: 'Normal message', createdAt: 120 },
  ]);
});

test('normalization strictly validates external types and preserves titles and option text', () => {
  for (const value of [undefined, null, false, 'questions', {}]) {
    expect(normalizeChatAsyncQuestions(value)).toEqual([]);
  }
  const options = [' A ', 'B'];
  const normalized = normalizeChatAsyncQuestions([
    null, [], true, {}, { title: 42, options: [] }, { title: '  ', options: null },
    { title: 'Missing options' }, { title: 'Wrong options', options: 'A' },
    { title: 'Mixed options', options: ['A', false] }, { title: 'Blank option', options: ['A', ' '] },
    { title: ' Scope? ', options }, { title: 'Freeform', options: null }, { title: 'Empty choices', options: [] },
  ]);
  expect(normalized).toEqual([
    { title: ' Scope? ', options: [' A ', 'B'] },
    { title: 'Freeform', options: null }, { title: 'Empty choices', options: [] },
  ]);
  options.push('later mutation');
  expect(normalized[0]?.options).toEqual([' A ', 'B']);
});
