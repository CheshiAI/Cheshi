import { expect, test } from 'bun:test';
import {
  CHAT_RELAY_MAX_TRANSCRIPT, chatRelayContextIds, chatRelayHistoryRecord, chatRelayRequest, chatRelayState, formatChatRelayConsensusReply, parseChatRelayConsensusReply,
  formatChatRelayMessage, parseChatRelayMessage, type ChatRelayConsensusReply, type ChatRelayState,
} from '../shared/chat-relay.ts';

const request = { sourceContextId: 'left', sourceThreadId: 'a', targetContextId: 'right', targetThreadId: 'b', objective: 'Plan together.' };

test('writes Cheshi relay messages while preserving saved Studio relay messages', () => {
  const provenance = { relayId: 'relay', step: 1, sourceThreadId: 'a', role: 'proposal' as const };
  const current = formatChatRelayMessage(provenance, 'A saved message.');
  expect(current.startsWith('[Cheshi relay]\n')).toBe(true);
  const legacy = current.replace('[Cheshi relay]', '[Studio relay]');
  expect(parseChatRelayMessage(current)).toEqual({ provenance, body: 'A saved message.' });
  expect(parseChatRelayMessage(legacy)).toEqual(parseChatRelayMessage(current));
});
const reply: ChatRelayConsensusReply = { kind: 'cheshi-relay-consensus', version: 1, decision: 'agree',
  proposal: 'The exact proposal.', issues: [], summary: 'I agree with this version.' };

test('normalizes saved Studio consensus replies to the Cheshi protocol', () => {
  const legacy = formatChatRelayConsensusReply(reply).replaceAll('cheshi-relay', 'studio-relay');
  expect(parseChatRelayConsensusReply(legacy)).toEqual(reply);
  expect(formatChatRelayConsensusReply(reply).startsWith('```cheshi-relay\n')).toBe(true);
});
const state: ChatRelayState = { sourceContextId: 'left', sourceThreadId: 'a', targetContextId: 'right', targetThreadId: 'b', id: 'relay', mode: 'consensus', maxRounds: 2,
  status: 'running', step: 4, round: 2, speaker: 'B', phase: 'review', outcome: null,
  proposalVersion: 2, proposal: 'Draft.', issues: ['Resolve timing.'], summary: null, message: null };

function encoded(value: unknown): string {
  return `\`\`\`cheshi-relay\n${JSON.stringify(value)}\n\`\`\``;
}

test('normalizes legacy review and bounded discussion defaults', () => {
  expect(chatRelayRequest(request)).toEqual({ ...request, mode: 'review', maxRounds: 1 });
  expect(chatRelayRequest({ ...request, mode: 'debate' }).maxRounds).toBe(3);
  expect(chatRelayRequest({ ...request, mode: 'consensus', maxRounds: 5 }).maxRounds).toBe(5);
  expect(chatRelayRequest({ ...request, mode: 'review', maxRounds: 5 }).maxRounds).toBe(1);
});

test('requires a separate moderator when explicitly selecting C and keeps auto selection valid', () => {
  const selected = { ...request, mode: 'debate', moderatorContextId: 'moderator', moderatorThreadId: 'c' };
  expect(chatRelayRequest(selected)).toMatchObject(selected);
  for (const change of [{ moderatorContextId: 'left' }, { moderatorThreadId: 'b' }, { moderatorContextId: '../bad' },
    { moderatorThreadId: undefined }, { moderatorContextId: undefined }, { mode: 'review' }, { mode: 'consensus' }]) {
    expect(() => chatRelayRequest({ ...selected, ...change })).toThrow();
  }
});

test('preserves moderator identity in history and only accepts C at the synthesis step', () => {
  const final = { ...state, mode: 'debate', maxRounds: 2, round: 2, step: 5, speaker: 'C', phase: 'synthesis',
    status: 'completed', outcome: 'debated', moderatorContextId: 'moderator', moderatorThreadId: 'c' };
  const parsed = chatRelayState(final);
  expect(parsed).toMatchObject(final);
  expect(chatRelayContextIds(parsed)).toEqual(['left', 'right', 'moderator']);
  expect(chatRelayContextIds(null)).toEqual([]);
  const stamp = '2026-09-08T01:00:00.000Z';
  expect(chatRelayHistoryRecord({ id: state.id, objective: 'Compare.', state: final,
    startedAt: stamp, updatedAt: stamp, finishedAt: stamp })?.state.moderatorThreadId).toBe('c');
  for (const change of [{ moderatorContextId: undefined, moderatorThreadId: undefined }, { speaker: 'A' },
    { phase: 'review' }, { round: 1 }, { step: 4 }, { outcome: 'agreed' }]) {
    expect(chatRelayState({ ...final, ...change })).toBeNull();
  }
});

test('retains two-source transcript metadata above the single-response limit', () => {
  const provenance = { relayId: 'relay', step: 11, sourceThreadId: 'b', sourceThreadIds: ['a', 'b'],
    role: 'synthesis' as const, mode: 'debate' as const, round: 5, displayText: 'x'.repeat(64_001) };
  expect(parseChatRelayMessage(formatChatRelayMessage(provenance, 'Prompt.'))?.provenance).toEqual(provenance);
  for (const change of [{ sourceThreadIds: ['a', 'a'] }, { sourceThreadIds: ['a', 'c'] },
    { sourceThreadIds: undefined }, { mode: 'review' as const }, { displayText: 'x'.repeat(CHAT_RELAY_MAX_TRANSCRIPT + 1) }]) {
    expect(parseChatRelayMessage(formatChatRelayMessage({ ...provenance, ...change }, 'Prompt.'))).toBeNull();
  }
});

test('rejects invalid modes and noninteger or unbounded rounds at the request boundary', () => {
  for (const mode of ['unknown', null, true, 1, {}]) expect(() => chatRelayRequest({ ...request, mode })).toThrow();
  for (const maxRounds of [0, -1, 6, 1.5, NaN, Infinity, '3', true, null]) {
    expect(() => chatRelayRequest({ ...request, mode: 'debate', maxRounds })).toThrow();
  }
});

test('validates extended progress and rejects malformed agreement results', () => {
  expect(chatRelayState(state)).toEqual(state);
  for (const change of [{ step: 7 }, { round: 3 }, { speaker: 'C' }, { proposalVersion: 3 }, { issues: [true] },
    { outcome: 'agreed', status: 'completed' }, { phase: 'unexpected' }]) {
    expect(chatRelayState({ ...state, ...change })).toBeNull();
  }
  expect(chatRelayState({ ...state, status: 'completed', outcome: 'agreed', issues: [] })?.outcome).toBe('agreed');
});

test('accepts the final debate review and rejects steps beyond its fixed bound', () => {
  const final = { ...state, mode: 'debate', maxRounds: 5, round: 5, step: 11, speaker: 'A', phase: 'review',
    status: 'completed', outcome: 'debated' };
  expect(chatRelayState(final)?.step).toBe(11);
  expect(chatRelayState({ ...final, step: 12 })).toBeNull();
});

test('validates archive identity, timestamps, lifecycle, and persistence errors', () => {
  const timestamp = '2026-09-08T01:00:00.000Z';
  const record = { id: state.id, objective: 'Plan together.', startedAt: timestamp, updatedAt: timestamp, finishedAt: null, state };
  expect(chatRelayHistoryRecord(record)).toEqual(record);
  for (const change of [{ id: '../relay' }, { id: 'different' }, { objective: '' }, { startedAt: 'yesterday' },
    { updatedAt: '2026-09-07T01:00:00.000Z' }, { finishedAt: timestamp }, { state: { ...state, status: 'completed' } }]) {
    expect(chatRelayHistoryRecord({ ...record, ...change })).toBeNull();
  }
  const completed = { ...record, finishedAt: timestamp, state: { ...state, status: 'completed' } };
  expect(chatRelayHistoryRecord(completed)).not.toBeNull();
  expect(chatRelayHistoryRecord({ ...completed, finishedAt: '2026-09-09T01:00:00.000Z' })).toBeNull();
  expect(chatRelayState({ ...state, historyError: true })).toBeNull();
  expect(chatRelayState({ ...state, historyError: 'Save failed.' })?.historyError).toBe('Save failed.');
});

test('recognizes only explicitly marked complete consensus replies', () => {
  expect(parseChatRelayConsensusReply(formatChatRelayConsensusReply(reply))).toEqual(reply);
  expect(parseChatRelayConsensusReply(JSON.stringify(reply))).toBeNull();
  expect(parseChatRelayConsensusReply(`Example:\n${encoded(reply)}`)).toBeNull();
  expect(parseChatRelayConsensusReply(encoded(reply).slice(0, -3))).toBeNull();
  expect(parseChatRelayConsensusReply('```cheshi-relay\ninvalid\n```')).toBeNull();
});

test('requires literal decisions, valid versions, issues and complete proposal data', () => {
  for (const change of [{ kind: 'other' }, { decision: true }, { decision: 'yes' }, { version: '1' },
    { version: 0 }, { version: 6 }, { issues: 'none' }, { issues: [null] }, { issues: [''] },
    { issues: Array(51).fill('issue') }, { proposal: false }, { summary: '' }]) {
    expect(parseChatRelayConsensusReply(encoded({ ...reply, ...change }))).toBeNull();
  }
  expect(parseChatRelayConsensusReply(encoded({ ...reply, proposal: null }))?.proposal).toBeNull();
});

test('round-trips later relay steps and human display metadata while retaining legacy messages', () => {
  const provenance = { relayId: 'relay', step: 8, sourceThreadId: 'a', role: 'discussion' as const,
    mode: 'debate' as const, round: 4, displayText: 'Peer reply.' };
  expect(parseChatRelayMessage(formatChatRelayMessage(provenance, 'Full control prompt.')))
    .toEqual({ provenance, body: 'Full control prompt.' });
  const legacy = { relayId: 'old', step: 2, sourceThreadId: 'a', role: 'review' as const };
  expect(parseChatRelayMessage(formatChatRelayMessage(legacy, 'Old message.'))?.provenance).toEqual(legacy);
  expect(parseChatRelayMessage(formatChatRelayMessage({ ...provenance, step: 16 }, 'Too many.'))).toBeNull();
});
