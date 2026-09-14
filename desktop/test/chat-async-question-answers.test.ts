import { expect, test } from 'bun:test';
import { completedAsyncQuestionAnswers } from '../frontend/src/features/chat/chatAsyncQuestionAnswers';
import type { ChatTimelineItem } from '../frontend/src/features/chat/model';

const card = (id = 'question'): ChatTimelineItem => ({
  id, kind: 'assistant', text: '', createdAt: 1,
  questions: [
    { title: '테스트 색상을 선택하세요', options: ['파랑', '초록'] },
    { title: '테스트 메모를 입력하세요', options: null },
  ],
});
const answer = (patch = {}): ChatTimelineItem => ({
  id: 'answer', kind: 'user', createdAt: 2,
  text: '테스트 색상을 선택하세요\n초록\n\n테스트 메모를 입력하세요\nUI_TEST_NOTE_20260914\nSecond line',
  ...patch,
});

test('restores submitted choices and multiline answers from reloaded conversation history', () => {
  const history: ChatTimelineItem[] = JSON.parse(JSON.stringify([card(), answer()]));
  expect(completedAsyncQuestionAnswers(history).get('question')).toEqual({
    '0': '초록', '1': 'UI_TEST_NOTE_20260914\nSecond line',
  });
});

test('does not complete questions for pending, failed, uncertain, unrelated or incomplete replies', () => {
  for (const patch of [
    { pending: true }, { delivery: 'failed' }, { delivery: 'unknown' },
    { text: 'Unrelated follow-up' }, { text: '테스트 색상을 선택하세요\n초록' },
    { text: '테스트 색상을 선택하세요\n초록\n\n테스트 메모를 입력하세요\n ' },
  ]) expect(completedAsyncQuestionAnswers([card(), answer(patch)]).size).toBe(0);
});

test('acceptance completes a pending answer and a successful retry completes a failed answer', () => {
  expect(completedAsyncQuestionAnswers([card(), answer({ pending: false })]).has('question')).toBe(true);
  expect(completedAsyncQuestionAnswers([card(), answer({ delivery: 'failed' }), answer({ id: 'retry' })])
    .has('question')).toBe(true);
});

test('matches only preceding questions and keeps different thread histories independent', () => {
  expect(completedAsyncQuestionAnswers([answer(), card()]).size).toBe(0);
  expect(completedAsyncQuestionAnswers([card(), answer()]).size).toBe(1);
  expect(completedAsyncQuestionAnswers([card()]).size).toBe(0);
});

test('a single reply closes only the latest matching card and later repeated questions stay open', () => {
  const completed = completedAsyncQuestionAnswers([card('older'), card('latest'), answer(), card('new')]);
  expect([...completed.keys()]).toEqual(['latest']);
});

test('supports independent question cards answered out of order and preserves the first answer', () => {
  const other: ChatTimelineItem = { id: 'other', kind: 'assistant', text: '', createdAt: 2,
    questions: [{ title: 'Another question?', options: null }] };
  const completed = completedAsyncQuestionAnswers([
    card(), other, answer(), answer({ id: 'other-answer', text: 'Another question?\nCustom answer' }),
    answer({ id: 'duplicate', text: '테스트 색상을 선택하세요\n파랑\n\n테스트 메모를 입력하세요\nChanged' }),
  ]);
  expect(completed.get('question')?.['0']).toBe('초록');
  expect(completed.get('other')).toEqual({ '0': 'Custom answer' });
});
