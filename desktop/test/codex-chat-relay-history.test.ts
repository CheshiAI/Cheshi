import { describe, expect, test } from 'bun:test';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';
import { chatSessionFromThread, timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { formatChatRelayMessage } from '../shared/chat-relay.ts';

describe('relay session titles', () => {
  const prompt = formatChatRelayMessage({
    relayId: 'relay-test', step: 3, sourceThreadId: 'thread-b', sourceThreadIds: ['thread-a', 'thread-b'],
    role: 'synthesis', mode: 'debate', round: 1, displayText: 'The participants disagree about scope.',
  }, 'Summarize the debate.');

  test('normalizes current and legacy moderator envelopes without changing saved messages', () => {
    for (const header of ['Cheshi', 'Studio']) {
      for (const newline of ['\n', '\r\n', '\r']) {
        const preview = prompt.replace('[Cheshi relay]', `[${header} relay]`).replaceAll('\n', newline);
        const thread = codexThread('moderator', { name: preview, preview, turns: [{
          id: 'turn', startedAt: 130,
          items: [{ id: 'message', type: 'userMessage', content: [{ type: 'text', text: preview }] }],
        }] });
        const before = structuredClone(thread);
        expect(chatSessionFromThread(thread)).toMatchObject({ title: 'Debate summary', preview: 'Debate summary' });
        expect(timelineFromThread(thread)).toEqual([{ id: 'message', turnId: 'turn', kind: 'user', text: preview, createdAt: 130 }]);
        expect(thread).toEqual(before);
      }
    }
  });

  test('hides truncated and flattened metadata in previews and generated names', () => {
    for (const preview of [prompt.slice(0, 160), prompt.replaceAll('\n', ' ').slice(0, 160), '[Cheshi relay]', '[Studio relay]\n{']) {
      for (const name of [null, preview, `${preview}…`]) {
        expect(chatSessionFromThread(codexThread('moderator', { name, preview })))
          .toMatchObject({ title: 'Connected conversation', preview: 'Connected conversation' });
      }
    }
    expect(chatSessionFromThread(codexThread('moderator', { name: prompt.slice(0, 80), preview: prompt }))?.title)
      .toBe('Debate summary');
  });

  test('preserves custom names, ordinary text, and agent naming priority', () => {
    expect(chatSessionFromThread(codexThread('moderator', { name: 'My discussion', preview: prompt })))
      .toMatchObject({ title: 'My discussion', preview: 'Debate summary' });
    expect(chatSessionFromThread(codexThread('agent', { agentNickname: 'Reviewer', preview: prompt }))?.title).toBe('Reviewer');
    for (const preview of ['Discuss [Cheshi relay] metadata', '[Cheshi relay] documentation', '[Cheshi relay]ish']) {
      expect(chatSessionFromThread(codexThread('ordinary', { preview }))).toMatchObject({ title: preview, preview });
    }
  });

  test('uses readable mode titles for connected participant sessions', () => {
    for (const [mode, title] of [['review', 'Review conversation'], ['debate', 'Debate conversation'], ['consensus', 'Consensus conversation']] as const) {
      const preview = formatChatRelayMessage({ relayId: 'relay-test', step: 1, sourceThreadId: 'thread-a', role: 'proposal', mode }, 'Discuss a label.');
      expect(chatSessionFromThread(codexThread('participant', { preview }))).toMatchObject({ title, preview: title });
    }
  });

  test('normalizes live title updates as well as loaded history', () => {
    const client = createFakeCodexClient();
    const service = createCodexChatService(client);
    const events: Record<string, unknown>[] = [];
    const unsubscribe = service.onEvent(event => events.push(event));
    try {
      for (const [threadName, title] of [[prompt, 'Debate summary'], [prompt.slice(0, 160), 'Connected conversation'], ['My discussion', 'My discussion'], ['', 'New chat']]) {
        client.emit('thread/name/updated', { threadId: 'moderator', threadName });
        expect(events.at(-1)).toEqual({ type: 'session-title', threadId: 'moderator', title });
      }
    } finally { unsubscribe(); }
  });
});
