import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { RoomMessage } from '../shared/agent-chats';
import { exchangeLabel, workLabel } from '../frontend/src/features/agent-chats/roomTimeline';
import { legacyReplyLinks } from '../frontend/src/features/agent-chats/useRoomTimeline';

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

test('unavailable or blocked work cannot be masked by sleeping workers', () => {
  const task: RoomMessage = { ...question, sender: 'user', kind: 'goal', status: 'blocked', worker: { phase: 'sleeping', error: null },
    goalProgress: { phase: 'unavailable', progress: '', reason: '', nextAction: '', turns: null, resumeBlocked: 'Check worker state' } };
  expect(workLabel(task)).toBe('Needs attention · current task state unavailable');
  expect(workLabel({ ...task, status: 'unknown' })).toBe('Execution needs checking');
  expect(workLabel({ ...task, status: 'running' })).toBe('Task state unavailable');
  expect(workLabel({ ...task, goalProgress: undefined })).toBe('Needs attention');
  expect(workLabel({ ...task, goalProgress: undefined, status: 'waiting' })).toBe('Waiting for a reply');
});
