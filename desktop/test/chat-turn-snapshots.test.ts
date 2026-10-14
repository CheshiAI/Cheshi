import { describe, expect, test } from 'bun:test';
import { completedChatTurnInputs, createCompletedChatTurnCache } from '../frontend/src/features/chat/chatTurnSnapshots';
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

describe('completed turn cache', () => {
  test('streamed text and command output reuse completed snapshots without reading old response bodies', () => {
    const read = createCompletedChatTurnCache();
    let oldTextReads = 0;
    const answer: ChatTimelineItem = { id: 'a1', kind: 'assistant', createdAt: 123,
      get text() { oldTextReads++; return '**Completed answer**'; } };
    const previous = [message('q1', 'user', 'First'), answer];
    const current = message('q2', 'user', 'Second');
    const first = read([...previous, current], 'thread', 'Session', true);
    const initialReads = oldTextReads;
    for (let index = 0; index < 100; index++) {
      const items: ChatTimelineItem[] = [...previous, current, message('a2', 'assistant', `Partial ${index}`),
        { id: 'command', kind: 'activity', activity: 'command', label: 'Command', detail: 'build',
          status: 'inProgress', output: `line ${index}` }];
      const next = read(items, 'thread', 'Session', true);
      expect(next).toBe(first);
      expect(next.get('a1')).toBe(first.get('a1'));
    }
    expect(oldTextReads).toBe(initialReads);
  });

  test('completion and a later turn preserve earlier snapshots and final command action placement', () => {
    const read = createCompletedChatTurnCache();
    const items: ChatTimelineItem[] = [message('q1', 'user', 'First'), message('a1', 'assistant', 'Done'),
      message('q2', 'user', 'Second'), { id: 'plan', kind: 'plan', text: 'Plan', createdAt: 124 },
      { id: 'command', kind: 'activity', activity: 'command', label: 'Command', detail: 'build', status: 'completed' }];
    const live = read(items, 'thread', 'Session', true);
    const done = read(items, 'thread', 'Session', false);
    expect(done).toEqual(completedChatTurnInputs(items, 'thread', 'Session', false));
    expect(done.get('a1')).toBe(live.get('a1'));
    expect(done.get('command')).toMatchObject({ itemId: 'plan', userText: 'Second', assistantText: 'Plan' });
    expect(read([...items, message('q3', 'user', 'Next')], 'thread', 'Session', true)).toBe(done);
    expect(read(items, 'thread', 'Session', true).has('command')).toBe(false);
  });

  test('edits invalidate only affected turns and equal reloaded content preserves row identity', () => {
    const read = createCompletedChatTurnCache();
    const items = [message('q1', 'user', 'First'), message('a1', 'assistant', 'Done'),
      message('q2', 'user', 'Second'), message('a2', 'assistant', 'Also done')];
    const first = read(items, 'thread', 'Session', false);
    expect(read(items.map(item => ({ ...item })), 'thread', 'Session', false)).toBe(first);
    const edited = [message('q1', 'user', 'Corrected question'), message('a1', 'assistant', 'Corrected answer'), ...items.slice(2)];
    const next = read(edited, 'thread', 'Session', false);
    expect(next.get('a1')).toMatchObject({ userText: 'Corrected question', assistantText: 'Corrected answer' });
    expect(next.get('a1')).not.toBe(first.get('a1'));
    expect(next.get('a2')).toBe(first.get('a2'));
    expect([...read(edited.slice(2), 'thread', 'Session', false).keys()]).toEqual(['a2']);
  });

  test('session title, thread changes, empty history, and unanswered turns cannot reuse stale metadata', () => {
    const read = createCompletedChatTurnCache();
    const items = [message('q', 'user', 'Question'), message('a', 'assistant', 'Answer')];
    const first = read(items, 'thread', 'Old title', false);
    const renamed = read(items, 'thread', 'New title', false);
    expect(renamed.get('a')).not.toBe(first.get('a'));
    expect(renamed.get('a')?.sessionTitle).toBe('New title');
    expect(read(items, 'other-thread', 'New title', false).get('a')?.threadId).toBe('other-thread');
    expect(read(items, null, '', false).size).toBe(0);
    expect(read([], 'thread', 'Session', false).size).toBe(0);
    expect(read([items[0]!], 'thread', 'Session', false).size).toBe(0);
    expect(read(items, 'thread', 'Session', false)).toEqual(completedChatTurnInputs(items, 'thread', 'Session', false));
  });
});
