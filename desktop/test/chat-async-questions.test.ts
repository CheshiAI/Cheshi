import { expect, test } from 'bun:test';
import { asyncQuestionsFromMessage, normalizeAsyncQuestions } from '../shared/chat-async-questions';
import { sessionFromThread, timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers';
import { INITIAL_CHAT_STATE, chatReducer, normalizeChatEvent, normalizeOpenSessionResponse } from '../frontend/src/features/chat/model';
import type { ChatState } from '../frontend/src/features/chat/model';
import { fallbackQuestionRequest, plainTextQuestion } from '../frontend/src/features/chat/chatQuestionChoices';
import { createFallbackQuestionStore } from '../frontend/src/features/chat/chatFallbackQuestionStore';
import type { ChatQuestionDismissal, ChatQuestionDismissalsApi } from '../shared/chat-question-dismissals';

const title = '이번에는 GPT 5.6-LUNA가 호출할 전용 스킬만 만들까요, 아니면 모델을 지정하는 전용 에이전트 설정까지 함께 만들까요?';
const options = ['스킬만 만들기', '스킬과 전용 에이전트 설정 함께 만들기'];
const questions = [{ title, options }];
const text = `${title}\n- ${options.join('\n- ')}`;
const message = { type: 'agentMessage', id: 'question', delivery: 'async', text, questions };

function restoredRequest(item: Record<string, unknown> = message) {
  const items = timelineFromThread({ turns: [{ id: 'turn', items: [item] }] });
  const restored = normalizeOpenSessionResponse({ session: sessionFromThread(codexThread('thread')), items });
  return fallbackQuestionRequest(restored.items, 'thread');
}

test.each([false, true])('live async question retains structured choices after prior text deltas: %s', async deltaFirst => {
  const client = createFakeCodexClient({ 'thread/start': { thread: codexThread('thread') }, 'turn/start': { turn: { id: 'turn' } } });
  const service = createCodexChatService(client);
  let state: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread' };
  service.onEvent(value => {
    const event = normalizeChatEvent(value);
    if (event) state = chatReducer(state, { type: 'event', event });
  });
  try {
    await service.sendMessage('Create the skill', 'first');
    if (deltaFirst) client.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'question', delta: text });
    client.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: message });
    // Replayed completion must neither duplicate the text nor lose the structured request.
    client.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: message });
    expect(state.items.filter(item => item.kind === 'assistant')).toEqual([
      expect.objectContaining({ id: 'question', text, turnId: 'turn', asyncQuestions: questions }),
    ]);
    expect(plainTextQuestion(text)).toBeNull();
    const live = fallbackQuestionRequest(state.items, 'thread');
    expect(live).toEqual(restoredRequest());
    expect(live).toMatchObject({ delivery: 'async', id: 'question:["thread","turn","question"]',
      questions: [{ question: title, options: options.map(label => ({ label, description: '' })) }] });
    expect(service.userInputs.list()).toEqual([]);
    client.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    expect(fallbackQuestionRequest(state.items, 'thread')).toEqual(live);
  } finally { await service.stop(); }
});

test('structured questions support arbitrary wording, multiple questions and free text without a body', () => {
  const request = restoredRequest({ ...message, text: '', questions: [{ title: '작업 범위', options }, { title: '추가 설명' }] });
  expect(request).toMatchObject({ delivery: 'async', questions: [
    { id: 'answer-1', question: '작업 범위', options: options.map(label => ({ label, description: '' })) },
    { id: 'answer-2', question: '추가 설명', options: null },
  ] });
});

test('validates async metadata at provider and renderer boundaries without accepting truthy delivery flags', () => {
  for (const value of [null, [], {}, [{ title: '' }], [{ title: 1 }], [{ title, options: 'yes' }],
    [{ title, options: [1] }], [{ title, options: [' '] }], [{ title }, null]]) {
    expect(normalizeAsyncQuestions(value)).toBeNull();
    expect(normalizeChatEvent({ type: 'assistant-question', threadId: 'thread', itemId: 'q', text, questions: value })).toBeNull();
  }
  for (const delivery of [undefined, null, true, 'true', 1, 'inline']) {
    expect(asyncQuestionsFromMessage({ ...message, delivery })).toBeNull();
    expect(restoredRequest({ ...message, delivery })).toBeNull();
  }
  expect(normalizeAsyncQuestions([{ title }, { title, options: null }])).toEqual([{ title, options: null }, { title, options: null }]);
});

test('async questions stay scoped to their conversation and stop being candidates after a user reply', () => {
  const event = normalizeChatEvent({ type: 'assistant-question', threadId: 'thread', turnId: 'turn', itemId: 'q', text, questions })!;
  const initial: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'other' };
  expect(chatReducer(initial, { type: 'event', event })).toBe(initial);
  const state = chatReducer({ ...initial, activeSessionId: 'thread' }, { type: 'event', event });
  const answered = chatReducer(state, { type: 'optimistic-user', id: 'answer', text: options[0]!, title: '', createdAt: 1 });
  expect(fallbackQuestionRequest(answered.items, 'thread')).toBeNull();
});

test('all structured answers are required, carry their question titles, and are submitted only once', async () => {
  const request = restoredRequest({ ...message, questions: [{ title: '범위', options }, { title: '추가 설명' }] })!;
  const sent: string[] = [];
  const store = createFallbackQuestionStore(async (text, threadId, candidate) => {
    expect(threadId).toBe('thread'); expect(candidate.delivery).toBe('async');
    sent.push(text); return { status: 'accepted' };
  });
  store.sync('thread', request, false);
  const answers = { 'answer-1': [options[0]!], 'answer-2': ['이 프로젝트에만 적용'] };
  expect(await store.respond(request.id, { action: 'accept', answers: { 'answer-1': answers['answer-1'] } })).toBe(false);
  expect(await store.respond(request.id, { action: 'accept', answers: { ...answers, unknown: ['extra'] } })).toBe(false);
  expect(sent).toEqual([]);
  const first = store.respond(request.id, { action: 'accept', answers });
  expect(await store.respond(request.id, { action: 'accept', answers })).toBe(false);
  expect(await first).toBe(true);
  expect(sent).toEqual([`범위\n${options[0]}\n\n추가 설명\n이 프로젝트에만 적용`]);
  store.sync('thread', request, false);
  expect(store.getSnapshot().request).toBeNull();
});

test.each(['accept', 'decline', 'cancel'] as const)('async question %s persists across reopening without resending', async action => {
  const records: ChatQuestionDismissal[] = [];
  const persistence: ChatQuestionDismissalsApi = {
    async list() { return records; },
    async save(_threadId, record) { records.push(record); return record; },
  };
  let sends = 0;
  const create = () => createFallbackQuestionStore(async () => { sends++; return { status: 'accepted' }; }, persistence);
  const request = restoredRequest()!;
  let store = create();
  store.sync('thread', request, false);
  await Promise.resolve();
  expect(await store.respond(request.id, { action, answers: { 'answer-1': [options[0]!] } })).toBe(true);
  store.setActive(false);
  store = create(); store.sync('thread', restoredRequest(), false);
  await Promise.resolve();
  expect(store.getSnapshot().request).toBeNull();
  expect(sends).toBe(action === 'accept' ? 1 : 0);
  expect(records[0]).toMatchObject({ questionId: request.id, turnId: 'turn', itemId: 'question' });
});
