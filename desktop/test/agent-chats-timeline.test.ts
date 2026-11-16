import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { RoomMessage } from '../shared/agent-chats';
import { exchangeLabel, messageRoot, timelineContexts, timelineIndex } from '../frontend/src/features/agent-chats/roomTimeline';
import { legacyReplyLinks } from '../frontend/src/features/agent-chats/useRoomTimeline';

import { MAX_TIMELINE_ROWS, RoomTimelineLayout } from '../frontend/src/features/agent-chats/roomTimelineLayout';

const rawId = 'a'.repeat(64);
const question: RoomMessage = { id: `peer_${rawId}`, roomId: 'room', threadId: 'goal', taskId: 'task', sender: 'dev', recipient: 'planner', kind: 'question', text: 'Question', createdAt: '2026-10-03', status: 'delivered' };
const reply: RoomMessage = { ...question, id: `peer_${createHash('sha256').update(`reply/${rawId}`).digest('hex')}`, sender: 'planner', recipient: 'dev', kind: 'reply', text: 'Answer' };

test('legacy links require the exact reply identity, room, task and participants', async () => {
  expect((await legacyReplyLinks([question, reply])).get(reply.id)).toBe(question.id);
  for (const patch of [{ id: 'other' }, { roomId: 'other' }, { taskId: 'other' }, { sender: 'other' }, { recipient: 'other' }, { questionId: 'another-question' }]) {
    expect((await legacyReplyLinks([question, { ...reply, ...patch }])).size).toBe(0);
  }
  expect((await legacyReplyLinks([{ ...question, taskId: undefined }, { ...reply, taskId: undefined }])).size).toBe(0);
  const verification = { ...question, kind: 'verification_request' as const };
  const result = { ...reply, kind: 'verification_result' as const, id: `peer_${createHash('sha256').update(`result/${rawId}`).digest('hex')}` };
  expect((await legacyReplyLinks([verification, result])).get(result.id)).toBe(question.id);
});

test('a legacy question is not assumed to be waiting; closure and late replies remain explicit', () => {
  expect(exchangeLabel(question, [question, reply])).toBe('Reply status unavailable');
  const linked = { ...reply, questionId: question.id };
  expect(exchangeLabel(question, [question, linked])).toBe('Answered');
  expect(exchangeLabel({ ...question, status: 'expired' }, [question, linked])).toBe('expired');
  expect(exchangeLabel(question, [question, { ...linked, status: 'late reply · not applied' }])).toBe('Reply status unavailable');
  expect(exchangeLabel(question, [question, { ...linked, kind: 'question_closed' }])).toBe('Closed');
  expect(exchangeLabel({ ...question, questionId: question.id }, [question])).toBe('Awaiting reply');
});

const taskRoot = (id: string): RoomMessage => ({ id, roomId: 'room', threadId: null,
  taskId: `task-${id}`, sender: 'user', recipient: 'dev', kind: 'message', text: `Original ${id}`,
  createdAt: '2026-10-03', status: 'running' });
const progress = (id: string, root: RoomMessage): RoomMessage => ({ ...root, id,
  sender: 'dev', recipient: null, threadId: root.id, text: `Progress ${id}` });

test('automatic context is quoted once per task across interleaved progress and commands; explicit replies remain', () => {
  const first = taskRoot('first'), second = taskRoot('second');
  const one = progress('one', first), two = progress('two', second);
  const command: RoomMessage = { ...progress('command', first), text: '', activity: {
    id: 'command', kind: 'command', title: 'capture', text: '', status: 'completed', createdAt: first.createdAt,
    turnId: 'turn', final: true, truncated: false,
  } };
  const explicit = { ...progress('explicit', first), replyTo: first.id };
  const messages = [first, second, one, two, command, progress('three', second), explicit];
  const contexts = timelineContexts(messages, timelineIndex(messages));
  expect([...contexts.keys()]).toEqual(['one', 'two', 'explicit']);
  expect(contexts.get('explicit')).toBe(first);
  const onlyOneTask = [first, one, command];
  expect(timelineContexts(onlyOneTask, timelineIndex(onlyOneTask)).size).toBe(0);
});

test('indexed roots and exchange labels match history lookup and reject cross-room context', () => {
  const root = taskRoot('goal');
  const linked = { ...reply, questionId: question.id };
  const other = { ...taskRoot('elsewhere'), roomId: 'other' };
  const messages = [root, question, linked, other, { ...progress('foreign', root), replyTo: other.id }];
  const index = timelineIndex(messages);
  for (const message of messages) {
    expect(index.root(message)).toEqual(messageRoot(message, messages));
    expect(exchangeLabel(message, messages, index)).toBe(exchangeLabel(message, messages));
  }
  expect(timelineContexts(messages, index).get('foreign')).not.toBe(other);
});

test('virtual layout bounds mounted rows and preserves identities after measurements, resizing and deletion', () => {
  const layout = new RoomTimelineLayout();
  const messages = Array.from({ length: 10000 }, (_, i) => taskRoot(`row-${i}`));
  layout.update(messages);
  for (let top = 0; top < 1800000; top += 54321) {
    const window = layout.window(top, 900, false);
    expect(window.end - window.start).toBeLessThanOrEqual(MAX_TIMELINE_ROWS);
    const anchor = layout.anchor(top)!;
    expect(layout.offset(anchor.id)! - anchor.offset).toBe(top);
    expect(window.before + window.after + (window.end - window.start) * 180).toBe(1800000);
  }
  const anchor = layout.anchor(9010)!;
  expect(layout.measure([['row-0', 400], ['row-1', 0]], 600)).toBe(true);
  expect(layout.offset(anchor.id)! - anchor.offset).toBe(9230);
  expect(layout.measure([['row-0', 400]], 600)).toBe(false);
  expect(layout.measure([['row-0', 200]], 300)).toBe(true);
  expect(layout.offset(anchor.id)! - anchor.offset).toBe(9030);
  layout.update(messages.slice(1));
  expect(layout.offset('row-0')).toBeUndefined();
  expect(layout.offset(anchor.id)! - anchor.offset).toBe(8830);
});
