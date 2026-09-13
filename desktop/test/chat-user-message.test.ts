import { describe, expect, test } from 'bun:test';

import {
  chatReducer, INITIAL_CHAT_STATE, normalizeChatEvent, normalizeOpenSessionResponse,
  type ChatState,
} from '../frontend/src/features/chat/model';
import { formatChatRelayConsensusReply, formatChatRelayMessage, parseChatRelayMessage } from '../shared/chat-relay';
import { relayAssistantDisplayText, relayDisplayText } from '../frontend/src/features/chat/chatRelayMessageView';

const relayText = `[Cheshi relay]\n${JSON.stringify({
  relayId: 'relay-one', step: 2, sourceThreadId: 'source-thread', role: 'review',
})}\n\nReview the proposal from the other session.`;

function userMessageEvent(overrides: Record<string, unknown> = {}) {
  return normalizeChatEvent({
    type: 'user-message', threadId: 'target-thread', clientMessageId: 'relay-step-two',
    text: relayText, createdAt: 123, ...overrides,
  });
}

function viewedState(): ChatState {
  return { ...INITIAL_CHAT_STATE, activeSessionId: 'target-thread' };
}

function applyUserMessage(state: ChatState, overrides: Record<string, unknown> = {}): ChatState {
  const event = userMessageEvent(overrides);
  if (!event) throw new Error('Expected a normalized user message event.');
  return chatReducer(state, { type: 'event', event });
}

describe('chat user message events', () => {
  test('reopens the complete moderator transcript with both source sessions intact', () => {
    const transcript = '### Round 1 · A\n\n**A position**\n\n### Round 1 · B\n\n**B position**';
    const provenance = { relayId: 'relay', step: 3, sourceThreadId: 'thread-b', sourceThreadIds: ['thread-a', 'thread-b'],
      role: 'synthesis' as const, mode: 'debate' as const, round: 1, displayText: transcript };
    const parsed = parseChatRelayMessage(formatChatRelayMessage(provenance, 'Internal moderator instruction.'));
    expect(parsed?.provenance).toEqual(provenance);
    if (!parsed) throw new Error('Expected moderator relay metadata.');
    expect(relayDisplayText(parsed)).toBe(transcript);
  });

  test('shows the objective alone for the initial relay proposal', () => {
    const objective = '테스트 계획을 만들어줘.\n실제 실행 없이 진행해줘.';
    expect(relayDisplayText({
      provenance: { relayId: 'relay', step: 1, sourceThreadId: 'source', role: 'proposal' },
      body: `This is a bounded three-step conversation relay: proposal, review, revision.\n\nObjective: ${objective}\n\nPropose an approach to the objective.`,
    })).toBe(objective);
  });

  test('shows only the received answer for review and revision, retaining Markdown and inner tags', () => {
    const answer = '**전달된 답변**\n\n- 첫 항목\n\n```xml\n<quoted_conversation_output>예시</quoted_conversation_output>\n```';
    for (const role of ['review', 'revision'] as const) {
      const instruction = role === 'review'
        ? 'Review the proposal for correctness, omissions, and tradeoffs. Give concrete feedback.'
        : 'Revise your earlier proposal using the review. Provide the final recommendation.';
      expect(relayDisplayText({
        provenance: { relayId: 'relay', step: role === 'review' ? 2 : 3, sourceThreadId: 'source', role },
        body: `This is a bounded three-step conversation relay: proposal, review, revision.\n\nObjective: 주제\n\n${instruction}\n\nCompleted output from conversation source:\n<quoted_conversation_output>\n${answer}\n</quoted_conversation_output>`,
      })).toBe(answer);
    }
  });

  test('preserves unfamiliar or incomplete relay content instead of dropping text', () => {
    const provenance = { relayId: 'relay', step: 2 as const, sourceThreadId: 'source', role: 'review' as const };
    for (const body of ['A normal relay message.', 'This is a bounded three-step conversation relay:\n<quoted_conversation_output>\nIncomplete']) {
      expect(relayDisplayText({ provenance, body })).toBe(body);
    }
  });

  test('uses explicit relay display text when reopening debate and consensus messages', () => {
    for (const mode of ['debate', 'consensus'] as const) {
      const displayText = '**Received answer**\n\n- Keep the conversation content.';
      const parsed = parseChatRelayMessage(formatChatRelayMessage({
        relayId: 'relay', step: 4, sourceThreadId: 'source', role: 'discussion', mode, round: 2, displayText,
      }, 'Internal instructions and protocol details'));
      if (!parsed) throw new Error('Expected relay provenance.');
      expect(relayDisplayText(parsed)).toBe(displayText);
    }
  });

  test('renders marked consensus replies as readable decisions and preserves ordinary code', () => {
    const text = formatChatRelayConsensusReply({
      kind: 'cheshi-relay-consensus', version: 2, decision: 'revise',
      proposal: 'Updated proposal', issues: ['Check cancellation'], summary: 'One issue remains.',
    });
    for (const streaming of [true, false]) {
      const display = relayAssistantDisplayText(text, streaming);
      expect(display).toContain('Changes requested · Proposal v2');
      expect(display).toContain('Updated proposal');
      expect(display).toContain('- Check cancellation');
      expect(display).not.toContain('cheshi-relay-consensus');
    }
    const ordinary = '```json\n{"decision":"agree"}\n```';
    expect(relayAssistantDisplayText(ordinary, false)).toBe(ordinary);
  });

  test('hides incomplete or invalid marked protocol while reporting its state', () => {
    const partial = '```cheshi-relay\n{"kind":"cheshi-relay-consensus",';
    expect(relayAssistantDisplayText(partial, true)).toBe('Preparing consensus response…');
    expect(relayAssistantDisplayText(`${partial}\n\`\`\``, false)).toBe('Consensus response could not be interpreted.');
  });

  test('a failed stop keeps the response active so the user can retry', () => {
    const streaming = chatReducer(viewedState(), {
      type: 'event', event: { type: 'turn-started', threadId: 'target-thread' },
    });
    const failedStop = chatReducer(streaming, { type: 'operation-error', message: 'Could not stop the response.' });
    expect(failedStop.phase).toBe('streaming');
    expect(failedStop.responseThreadIds).toEqual(['target-thread']);
    expect(failedStop.items).toBe(streaming.items);
    expect(failedStop.error).toBe('Could not stop the response.');
  });

  test('rejects missing thread, client message id, and text', () => {
    for (const field of ['threadId', 'clientMessageId', 'text']) {
      expect(userMessageEvent({ [field]: '' })).toBeNull();
      expect(userMessageEvent({ [field]: 1 })).toBeNull();
    }
  });

  test('adds relay prompts only to the target session and handles redelivery idempotently', () => {
    const original = viewedState();
    expect(applyUserMessage(original, { threadId: 'other-thread' })).toBe(original);
    const delivered = applyUserMessage(original);
    expect(delivered.items).toEqual([{
      kind: 'user', id: 'client:relay-step-two', text: relayText, createdAt: 123, pending: false,
    }]);
    expect(applyUserMessage(delivered)).toBe(delivered);
    expect(delivered.activeSessionId).toBe('target-thread');
  });

  test('reconciles the matching optimistic item without duplicating or moving it', () => {
    const optimistic = chatReducer(viewedState(), {
      type: 'optimistic-user', id: 'client:relay-step-two', text: 'Draft prompt',
      title: 'Draft prompt', createdAt: 120,
    });
    const withResponse = chatReducer(optimistic, {
      type: 'event', event: {
        type: 'assistant-delta', threadId: 'target-thread', itemId: 'assistant-one',
        text: 'Reviewing…', createdAt: 124,
      },
    });
    const echoed = applyUserMessage(withResponse);
    expect(echoed.items).toHaveLength(2);
    expect(echoed.items[0]).toMatchObject({ id: 'client:relay-step-two', text: relayText, pending: false });
    expect(echoed.items[1]).toBe(withResponse.items[1]);
  });

  test('does not merge different prompts that happen to have identical text', () => {
    const first = applyUserMessage(viewedState());
    const second = applyUserMessage(first, { clientMessageId: 'relay-step-four' });
    expect(second.items).toHaveLength(2);
  });

  test('preserves relay provenance in persisted session history', () => {
    const reopened = normalizeOpenSessionResponse({
      session: { id: 'target-thread', title: 'Review', preview: '', createdAt: 100, updatedAt: 123, status: 'idle' },
      items: [{ id: 'server-item', kind: 'user', text: relayText, createdAt: 123 }],
    });
    const item = reopened.items[0];
    if (!item || item.kind !== 'user') throw new Error('Expected a user message.');
    expect(parseChatRelayMessage(item.text)).toEqual({
      provenance: { relayId: 'relay-one', step: 2, sourceThreadId: 'source-thread', role: 'review' },
      body: 'Review the proposal from the other session.',
    });
    expect(parseChatRelayMessage('A normal user prompt.')).toBeNull();
  });
});
