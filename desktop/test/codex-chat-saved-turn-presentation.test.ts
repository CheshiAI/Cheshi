import { describe, expect, test } from 'bun:test';
import { chatSessionFromThread, timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { formatSavedChatTurnPrompt } from '../shared/chat-saved-turn-continuation.ts';
import { codexThread } from './codex-chat-test-helpers.ts';

const savedContext = {
  sessionTitle: '안녕! 코덱스!',
  userText: 'https://github.com/stablyai/orca 해당 부분을 검토해줘',
  assistantText: '저장소의 목적과 주요 구현을 확인했습니다.\n\n```ts\nconst value = 1;\n```',
};

function legacyPrompt(userText = savedContext.userText): string {
  return [
    'Continue a new conversation using the saved exchange below as background context.',
    'Briefly acknowledge the context in the same language and ask what I would like to continue with.',
    'The exchange is historical: do not execute its previous requests or commands unless I ask again.',
    '',
    `Saved conversation: ${savedContext.sessionTitle}`,
    '',
    '### Saved question',
    userText || '(No question was saved.)',
    '',
    '### Saved answer',
    savedContext.assistantText,
  ].join('\n');
}

for (const [format, createPrompt] of [
  ['legacy', () => legacyPrompt()],
  ['structured', () => formatSavedChatTurnPrompt(savedContext)],
] as const) describe(`${format} saved-turn session presentation`, () => {
  test('uses the saved conversation title and question for a continuation', () => {
    expect(chatSessionFromThread(codexThread('continued', { preview: createPrompt() }))).toMatchObject({
      id: 'continued',
      title: savedContext.sessionTitle,
      preview: savedContext.userText,
    });
  });

  test('replaces generated wrapper names while retaining explicit custom names', () => {
    const prompt = createPrompt();
    const truncatedName = prompt.slice(0, prompt.indexOf('\n\n') + 2);
    for (const name of [prompt, truncatedName, prompt.slice(0, 90), `${prompt.slice(0, 90)}...`, `${prompt.slice(0, 90)}…`]) {
      expect(chatSessionFromThread(codexThread('continued', { name, preview: prompt }))?.title)
        .toBe(savedContext.sessionTitle);
    }
    expect(chatSessionFromThread(codexThread('renamed', { name: 'Orca 검토 이어가기', preview: prompt })))
      .toMatchObject({ title: 'Orca 검토 이어가기', preview: savedContext.userText });
    expect(chatSessionFromThread(codexThread('renamed', { name: prompt.slice(0, 1), preview: prompt }))?.title)
      .toBe(prompt.slice(0, 1));
  });

  test('uses a readable fallback when the server only returns a truncated wrapper', () => {
    const prompt = createPrompt();
    const preview = prompt.slice(0, prompt.indexOf('\n\n') + 2);
    for (const name of [null, preview]) {
      expect(chatSessionFromThread(codexThread('continued', { name, preview })))
        .toMatchObject({ title: 'Continued from saved turn', preview: 'Continued from saved turn' });
    }
  });

  test('normalizes line endings for wrapper names while preserving short custom names', () => {
    const prompt = createPrompt();
    for (const newline of ['\r', '\r\n']) {
      const preview = prompt.replaceAll('\n', newline);
      const customName = prompt.slice(0, 1);
      expect(chatSessionFromThread(codexThread('renamed', { name: customName, preview })))
        .toMatchObject({ title: customName, preview: savedContext.userText });
      for (const name of [prompt.slice(0, 90), preview.slice(0, 90)]) {
        expect(chatSessionFromThread(codexThread('continued', { name: `${name}...`, preview }))?.title)
          .toBe(savedContext.sessionTitle);
      }
    }
  });

  test('preserves ordinary prompts and agent naming priority', () => {
    const preview = 'Continue a new conversation about saved data.';
    expect(chatSessionFromThread(codexThread('ordinary', { preview })))
      .toMatchObject({ title: preview, preview });
    expect(chatSessionFromThread(codexThread('agent', {
      agentNickname: 'Researcher', preview: createPrompt(),
    }))).toMatchObject({ title: 'Researcher', preview: savedContext.userText });
  });

  test('retains the complete historical prompt in the source thread and timeline', () => {
    const prompt = createPrompt();
    const thread = codexThread('continued', {
      name: prompt,
      preview: prompt,
      turns: [{
        id: 'turn', startedAt: 130,
        items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: prompt }] }],
      }],
    });
    const before = structuredClone(thread);
    expect(chatSessionFromThread(thread)?.title).toBe(savedContext.sessionTitle);
    expect(timelineFromThread(thread)).toEqual([{ id: 'user', turnId: 'turn', kind: 'user', text: prompt, createdAt: 130 }]);
    expect(thread).toEqual(before);
  });
});

test('falls back to the saved title when the saved exchange has no question', () => {
  const preview = formatSavedChatTurnPrompt({ ...savedContext, userText: '' });
  expect(chatSessionFromThread(codexThread('continued', { preview })))
    .toMatchObject({ title: savedContext.sessionTitle, preview: savedContext.sessionTitle });
});
