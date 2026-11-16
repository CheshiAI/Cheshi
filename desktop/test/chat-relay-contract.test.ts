import { expect, test } from 'bun:test';
import {
  CHAT_RELAY_MAX_TRANSCRIPT, formatChatRelayConsensusReply, parseChatRelayConsensusReply,
  formatChatRelayMessage, parseChatRelayMessage, type ChatRelayConsensusReply,
} from '../shared/chat-relay.ts';

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
function encoded(value: unknown): string {
  return `\`\`\`cheshi-relay\n${JSON.stringify(value)}\n\`\`\``;
}

test('retains two-source transcript metadata above the single-response limit', () => {
  const provenance = { relayId: 'relay', step: 11, sourceThreadId: 'b', sourceThreadIds: ['a', 'b'],
    role: 'synthesis' as const, mode: 'debate' as const, round: 5, displayText: 'x'.repeat(64_001) };
  expect(parseChatRelayMessage(formatChatRelayMessage(provenance, 'Prompt.'))?.provenance).toEqual(provenance);
  for (const change of [{ sourceThreadIds: ['a', 'a'] }, { sourceThreadIds: ['a', 'c'] },
    { sourceThreadIds: undefined }, { mode: 'review' as const }, { displayText: 'x'.repeat(CHAT_RELAY_MAX_TRANSCRIPT + 1) }]) {
    expect(parseChatRelayMessage(formatChatRelayMessage({ ...provenance, ...change }, 'Prompt.'))).toBeNull();
  }
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
