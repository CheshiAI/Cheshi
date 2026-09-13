import { describe, expect, test } from 'bun:test';
import { completedChatTurnInputs } from '../frontend/src/features/chat/chatTurnSnapshots';
import type { ChatTimelineItem } from '../frontend/src/features/chat/model';
import { formatChatRelayMessage } from '../shared/chat-relay';
import { formatSavedChatTurnPrompt } from '../shared/chat-saved-turn-continuation';

const message = (id: string, kind: 'user' | 'assistant' | 'reasoning', text: string): ChatTimelineItem => ({ id, kind, text, createdAt: 123 });

describe('saved turn snapshots', () => {
  test('offers one action row per turn and preserves full Markdown and its question', () => {
    const items: ChatTimelineItem[] = [message('q', 'user', 'Question'), message('a1', 'assistant', 'Checking…'),
      { id: 'tool', kind: 'activity', activity: 'command', label: 'Command', detail: 'ls', status: 'completed' },
      message('reason', 'reasoning', 'Private intermediate notes'), message('a2', 'assistant', '**Answer**\n\n```ts\nconst a = 1;\n```'),
      message('q2', 'user', 'Second question'), message('a3', 'assistant', 'Second answer')];
    const turns = completedChatTurnInputs(items, 'thread', 'Session', false);
    expect([...turns.keys()]).toEqual(['a2', 'a3']);
    expect(turns.get('a2')).toEqual({ threadId: 'thread', itemId: 'a2', sessionTitle: 'Session', userText: 'Question',
      assistantText: 'Checking…\n\n**Answer**\n\n```ts\nconst a = 1;\n```', createdAt: 123 });
    expect(turns.get('a3')?.userText).toBe('Second question');
  });

  test('keeps previous turns available while the latest response is streaming, even after a tool item', () => {
    const items: ChatTimelineItem[] = [message('q1', 'user', 'First'), message('a1', 'assistant', 'Done'),
      message('q2', 'user', 'Second'), message('a2', 'assistant', 'Working'),
      { id: 'tool', kind: 'activity', activity: 'command', label: 'Command', detail: 'ls', status: 'inProgress' }];
    expect([...completedChatTurnInputs(items, 'thread', 'Session', true).keys()]).toEqual(['a1']);
    expect([...completedChatTurnInputs(items, 'thread', 'Session', false).keys()]).toEqual(['a1', 'tool']);
    expect(completedChatTurnInputs(items, 'thread', 'Session', false).get('tool')).toMatchObject({
      itemId: 'a2', userText: 'Second', assistantText: 'Working',
    });
  });

  test('does not save a missing thread, unanswered question, or empty assistant message', () => {
    expect(completedChatTurnInputs([message('a', 'assistant', 'Hello')], null, '', false).size).toBe(0);
    expect(completedChatTurnInputs([message('q', 'user', 'Hello')], 'thread', '', false).size).toBe(0);
    expect(completedChatTurnInputs([message('a', 'assistant', ' ')], 'thread', '', false).size).toBe(0);
  });

  test('keeps actions after trailing reasoning and preserves a completed plan snapshot', () => {
    const items: ChatTimelineItem[] = [message('q', 'user', 'Plan'),
      { id: 'plan', kind: 'plan', text: 'The plan', createdAt: 124 },
      message('reason', 'reasoning', 'Intermediate notes'), message('q2', 'user', 'Next')];
    const turns = completedChatTurnInputs(items, 'thread', 'Session', true);
    expect([...turns.keys()]).toEqual(['reason']);
    expect(turns.get('reason')).toMatchObject({ itemId: 'plan', userText: 'Plan', assistantText: 'The plan', createdAt: 124 });
  });

  test('stores the visible relay prompt instead of the internal relay envelope', () => {
    const text = formatChatRelayMessage({ relayId: 'relay', role: 'proposal', sourceThreadId: 'source', step: 1,
      mode: 'review', round: 1, displayText: 'Visible question' }, 'Internal instructions');
    const turns = completedChatTurnInputs([message('q', 'user', text), message('a', 'assistant', 'Answer')], 'target', 'Relay', false);
    expect(turns.get('a')?.userText).toBe('Visible question');
  });

  test('resaving a continued turn preserves the earlier exchange without the internal instructions', () => {
    const text = formatSavedChatTurnPrompt({ sessionTitle: '안녕! 코덱스!',
      userText: '이 저장소를 검토해줘', assistantText: '**이전 검토 결과**\n\n세 가지 문제가 있습니다.' });
    const turns = completedChatTurnInputs([message('q', 'user', text), message('a', 'assistant', '어떤 부분을 이어갈까요?')],
      'new-thread', 'New discussion', false);
    const snapshot = turns.get('a');
    expect(snapshot?.userText).toBe('안녕! 코덱스!\n\n### You\n이 저장소를 검토해줘\n\n### Assistant\n**이전 검토 결과**\n\n세 가지 문제가 있습니다.');
    expect(snapshot?.assistantText).toBe('어떤 부분을 이어갈까요?');
    expect(snapshot?.userText).not.toContain('The exchange is historical');
  });
});

test('completed plans can be copied and saved with their original question', () => {
  const items: ChatTimelineItem[] = [message('q', 'user', 'Plan the change'),
    { id: 'plan', kind: 'plan', text: '## Plan\n\n1. Review\n2. Implement', createdAt: 124 }];
  expect(completedChatTurnInputs(items, 'thread', 'Planning', true).size).toBe(0);
  expect(completedChatTurnInputs(items, 'thread', 'Planning', false).get('plan')).toMatchObject({
    userText: 'Plan the change', assistantText: '## Plan\n\n1. Review\n2. Implement', itemId: 'plan',
  });
});
