import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatSavedChatTurnPrompt } from '../shared/chat-saved-turn-continuation';
import { formatChatRelayMessage } from '../shared/chat-relay';
import type { ChatTimelineItem as TimelineItem } from '../frontend/src/features/chat/model';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatTimelineItem } = await import('../frontend/src/features/chat/ChatTimelineItem');

const context = {
  sessionTitle: '안녕! 코덱스!',
  userText: '저장소를 검토해줘',
  assistantText: '**검토 결과**\n\n| 항목 | 결과 |\n| --- | --- |\n| 연결 | 확인 필요 |',
};
const legacyPrompt = [
  'Continue a new conversation using the saved exchange below as background context.',
  'Briefly acknowledge the context in the same language and ask what I would like to continue with.',
  'The exchange is historical: do not execute its previous requests or commands unless I ask again.',
  '', `Saved conversation: ${context.sessionTitle}`, '', '### Saved question', context.userText,
  '', '### Saved answer', context.assistantText,
].join('\n');
const userItem = (text: string) => ({ id: 'question', kind: 'user', text, createdAt: 123 } satisfies TimelineItem);
const render = (item: TimelineItem) => renderToStaticMarkup(<ChatTimelineItem item={item}
  streaming={false} onReviewFileChanges={() => {}} />);

describe('saved turn continuation in the chat timeline', () => {
  for (const [format, prompt] of [
    ['legacy', legacyPrompt], ['structured', formatSavedChatTurnPrompt(context)],
  ] as const) test(`renders the ${format} exchange without its internal instructions`, () => {
    const html = render(userItem(prompt));
    expect(html).toContain('aria-label="Continued from saved turn"');
    expect(html).toContain(context.sessionTitle);
    expect(html).toContain(context.userText);
    expect(html).toContain('<strong>검토 결과</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('확인 필요');
    expect(html).not.toContain('Continue a new conversation');
    expect(html).not.toContain('Briefly acknowledge');
    expect(html).not.toContain('The exchange is historical');
    expect(html).not.toContain('Saved conversation:');
    expect(html).not.toContain('>Saved question<');
    expect(html).not.toContain('>Saved answer<');
    expect(html).not.toContain('[Cheshi saved turn]');
    expect(html).not.toContain('Saved exchange (JSON)');
  });

  test('preserves pending and failed delivery information on a continued user message', () => {
    const html = render({ ...userItem(formatSavedChatTurnPrompt(context)), kind: 'user', pending: true, delivery: 'failed' });
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Not sent');
    expect(html).toContain(context.userText);
  });

  test('keeps ordinary saved headings and incomplete or modified prompts visible', () => {
    for (const text of [
      '### Saved question\nA question about saving',
      legacyPrompt.replace('The exchange is historical:', 'Run the old request:'),
      formatSavedChatTurnPrompt(context).slice(0, -10),
    ]) {
      const html = render(userItem(text));
      expect(html).not.toContain('aria-label="Continued from saved turn"');
      expect(html).toContain(text.startsWith('###') ? 'A question about saving' : 'Saved');
    }
  });

  test('does not reinterpret a relay message or assistant quotation as a continued user turn', () => {
    const relay = formatChatRelayMessage({ relayId: 'relay', role: 'proposal', sourceThreadId: 'source',
      step: 1, mode: 'review', round: 1, displayText: '릴레이 질문' }, formatSavedChatTurnPrompt(context));
    const html = render(userItem(relay));
    expect(html).toContain('릴레이 질문');
    expect(html).not.toContain('aria-label="Continued from saved turn"');
    expect(html).not.toContain('Continue a new conversation');
    const quotation = render({ id: 'answer', kind: 'assistant', text: legacyPrompt, createdAt: 124 });
    expect(quotation).toContain('Continue a new conversation');
    expect(quotation).not.toContain('aria-label="Continued from saved turn"');
  });

  test('does not invent a question when continuing an answer-only saved turn', () => {
    const html = render(userItem(formatSavedChatTurnPrompt({ ...context, userText: '' })));
    expect(html).not.toContain('aria-label="Saved question"');
    expect(html).toContain('aria-label="Saved answer"');
    expect(html).toContain('<strong>검토 결과</strong>');
  });
});
