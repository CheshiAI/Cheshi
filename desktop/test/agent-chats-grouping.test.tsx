import { expect, test } from 'bun:test';
import { act } from 'react';
import type { RoomMessage } from '../shared/agent-chats';
import { ChatsTimeline } from '../frontend/src/features/agent-chats/ChatsTimeline';
import { continuesResponse } from '../frontend/src/features/agent-chats/roomTimeline';
import { MAX_TIMELINE_ROWS, RoomTimelineLayout } from '../frontend/src/features/agent-chats/roomTimelineLayout';
import { withDOM } from './agent-chats-test-dom';

function receipt(id: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return { id, roomId: 'room', threadId: 'request', sender: 'atlas', recipient: null,
    taskId: 'capture', kind: 'message', text: '', createdAt: '2026-10-16T13:03:00Z',
    activity: { id, turnId: 'turn', kind: 'command', title: `capture ${id}`, text: `output ${id}`,
      status: 'completed', final: false, truncated: false, createdAt: '2026-10-16T13:03:00Z' }, ...overrides };
}

test('grouping requires matching sender, task and native turn; missing identities never infer a response', () => {
  const first = receipt('first'), next = receipt('next');
  expect(continuesResponse(first, next)).toBe(true);
  const boundaries: Partial<RoomMessage>[] = [
    { sender: 'another' }, { sender: 'user' }, { taskId: 'other-task' }, { taskId: undefined },
    { activity: undefined }, { activity: { ...next.activity!, turnId: 'resumed-turn' } },
    { activity: { ...next.activity!, turnId: '' } }, { roomId: 'other-room' },
    { recipient: 'another' }, { threadId: 'follow-up' }, { replyTo: 'question' },
    { questionId: 'question' }, { kind: 'permission_request' },
  ];
  for (const override of boundaries) {
    expect(continuesResponse(first, receipt('boundary', override))).toBe(false);
    expect(continuesResponse(receipt('boundary', override), next)).toBe(false);
  }
  expect(continuesResponse(undefined, next)).toBe(false);
  expect(continuesResponse(first, undefined)).toBe(false);
  expect(continuesResponse(receipt('old', { taskId: undefined }), receipt('new', { taskId: undefined }))).toBe(false);
});

const room = { id: 'room', workspace: '/project', name: 'Atlas', engineId: 'docker:test',
  members: [{ id: 'atlas', accountId: 'account', name: 'Atlas' }], defaultAgentId: 'atlas', createdAt: '2026-10-16' };
const noMutation = async () => {};
function timeline(messages: RoomMessage[], start = 0, end = messages.length, onReply = (_message: RoomMessage) => {}) {
  return <ChatsTimeline room={room} messages={messages} agents={[]} api={undefined} sending={false}
    mutate={noMutation} onReply={onReply} onRetry={noMutation}
    window={{ start, end, before: start * 100, after: (messages.length - end) * 100 }} />;
}
const row = (id: string) => document.querySelector(`[data-message-id="${id}"]`);

test('one header covers consecutive text and tools; another speaker, task or turn starts a new header', async () => {
  const intro = receipt('intro');
  intro.text = 'I will capture the screen.';
  intro.activity = { ...intro.activity!, kind: 'message', text: intro.text };
  const messages = [intro, receipt('one'), receipt('two'),
    receipt('user', { sender: 'user', activity: undefined, text: 'Continue' }), receipt('after-user'),
    receipt('other-agent', { sender: 'other' }), receipt('after-other'),
    receipt('other-task', { taskId: 'second-task' }), receipt('after-task'),
    receipt('new-turn', { activity: { ...intro.activity!, turnId: 'new-turn' } })];
  await withDOM(async ui => {
    await ui.render(timeline(messages));
    expect(document.querySelectorAll('time')).toHaveLength(8);
    expect(row('one')?.querySelector('time')).toBeNull();
    expect(row('two')?.querySelector('time')).toBeNull();
    for (const id of ['intro', 'user', 'after-user', 'other-agent', 'after-other', 'other-task', 'after-task', 'new-turn']) {
      expect(row(id)?.querySelector('time')).not.toBeNull();
    }
    expect([...document.querySelectorAll('[data-message-id]')].map(element => element.getAttribute('data-message-id')))
      .toEqual(messages.map(message => message.id));
    expect(row('one')?.textContent).toContain('capture one');
    expect(row('two')?.textContent).toContain('capture two');
  });
});

test('streamed continuation retains its element, status and per-message reply target', async () => {
  const first = receipt('first'), answer = receipt('answer', { text: 'Partial response' });
  answer.activity = { ...answer.activity!, kind: 'message', text: answer.text, status: 'running', final: true };
  let replied: RoomMessage | undefined;
  await withDOM(async ui => {
    const render = (message: RoomMessage) => ui.render(timeline([first, message], 0, 2, value => { replied = value; }));
    await render(answer);
    const element = row('answer');
    expect(document.querySelectorAll('time')).toHaveLength(1);
    expect(element?.getAttribute('aria-busy')).toBe('true');
    expect(element?.textContent).toContain('Writing…');
    expect(element?.hasAttribute('data-copy-action')).toBe(true);
    await ui.click('Reply to Partial response');
    expect(replied?.id).toBe('answer');
    const completed = { ...answer, text: 'Complete response', activity: { ...answer.activity!, status: 'completed' as const } };
    await render(completed);
    expect(row('answer')).toBe(element);
    expect(element?.textContent).toContain('Complete response');
    expect(element?.textContent).not.toContain('Writing…');
    expect(element?.hasAttribute('aria-busy')).toBe(false);
    await render({ ...completed, status: 'unknown', activity: { ...completed.activity, status: 'unknown' } });
    expect(element?.textContent).toContain('Incomplete response');
    expect(element?.textContent).toContain('unknown');
  });
});

test('grouped command cards retain independent expansion and output across updates', async () => {
  const first = receipt('first'), second = receipt('second');
  await withDOM(async ui => {
    await ui.render(timeline([first, second]));
    const firstCard = row('first')!.querySelector('details')!;
    const secondCard = row('second')!.querySelector('details')!;
    await act(async () => secondCard.querySelector('summary')!.click());
    expect(firstCard.open).toBe(false);
    expect(secondCard.open).toBe(true);
    await ui.render(timeline([first, { ...second, activity: { ...second.activity!, text: 'Updated output', status: 'failed' } }]));
    expect(row('second')!.querySelector('details')).toBe(secondCard);
    expect(secondCard.open).toBe(true);
    expect(secondCard.textContent).toContain('Updated output');
    expect(secondCard.querySelector('summary')?.textContent).toContain('Failed');
    expect(firstCard.textContent).not.toContain('Updated output');
  });
});

test('virtual windows keep response boundaries and bounded rows without repeating offscreen headers', async () => {
  const messages = Array.from({ length: 200 }, (_, index) => receipt(`item-${index}`));
  const layout = new RoomTimelineLayout();
  layout.update(messages);
  await withDOM(async ui => {
    await ui.render(timeline(messages, 120));
    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(MAX_TIMELINE_ROWS);
    expect(document.querySelectorAll('time')).toHaveLength(0);
    expect(row('item-120')?.getAttribute('data-continuation')).toBe('true');
    expect(row('item-120')?.getAttribute('aria-label')).toContain('Atlas');
    layout.measure(messages.map(message => [message.id, 80] as const), 800);
    const anchor = layout.anchor(10_000)!;
    await ui.render(timeline(messages, 100, 180));
    expect(row('item-100')?.getAttribute('data-continuation')).toBe('true');
    expect(layout.offset(anchor.id)! - anchor.offset).toBe(10_000);
    await ui.render(timeline(messages, 0, 80));
    expect(document.querySelectorAll('time')).toHaveLength(1);
    expect(row('item-0')?.hasAttribute('data-continuation')).toBe(false);
  });
});
