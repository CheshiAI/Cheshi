import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatUserInputRequest } from '../shared/chat-user-input';
import { initialInputDraft, inputResponse, userInputLink } from '../frontend/src/features/chat/chatUserInputForm';
import { chatReducer, INITIAL_CHAT_STATE, normalizeChatEvent } from '../frontend/src/features/chat/model';
import { ChatQuestionFields } from '../frontend/src/features/chat/ChatUserInputFields';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatUserInputPrompt } = await import('../frontend/src/features/chat/ChatUserInputPrompt');
const question: ChatUserInputRequest = {
  id: 'input-one', threadId: 'thread-one', turnId: 'turn-one', kind: 'questions', isBlocking: true,
  questions: [
    { id: 'choice', header: 'Scope', question: 'Which scope?', isOther: true, isSecret: false,
      options: [{ label: 'Local', description: 'Only this project.' }] },
    { id: 'text', header: 'Details', question: 'Enter details.', isOther: false, isSecret: true, options: null },
  ],
};
const form: ChatUserInputRequest = {
  id: 'form-one', threadId: 'thread-one', turnId: null, kind: 'form', serverName: 'Example MCP', message: 'Configure the request.',
  fields: [
    { name: 'count', title: 'Count', description: '', type: 'integer', required: true, default: 0 },
    { name: 'enabled', title: 'Enabled', description: '', type: 'boolean', required: true, default: false },
    { name: 'tags', title: 'Tags', description: '', type: 'array', required: true, default: ['a'], options: [{ value: 'a', label: 'Alpha' }] },
    { name: 'note', title: 'Note', description: '', type: 'string', required: false },
  ],
};
const render = (request: ChatUserInputRequest, pending = false) => renderToStaticMarkup(
  <ChatUserInputPrompt request={request} respond={async () => true} pending={pending} error={null} />);

describe('chat input requests', () => {
  test('offers non-submit clear controls only for populated custom answers', () => {
    if (question.kind !== 'questions') throw new Error('Expected question fixture.');
    const renderFields = (choice: string) => renderToStaticMarkup(<ChatQuestionFields questions={question.questions}
      draft={{ choice, text: 'Private answer' }} onChange={() => {}} />);
    const custom = renderFields('Custom scope');
    expect(custom).toMatch(/<button[^>]*aria-label="Clear Scope answer"[^>]*type="button"/);
    expect(custom).toMatch(/<button[^>]*aria-label="Clear Details answer"[^>]*type="button"/);
    expect(custom).toMatch(/<input[^>]*type="password"/);
    expect(renderFields('Local')).not.toContain('Clear Scope answer');
    expect(renderFields('')).not.toContain('Clear Scope answer');
    expect(() => inputResponse(question, { choice: '', text: 'Private answer' })).toThrow('Answer Scope');
  });
  test('presents option descriptions, custom answers and masked text with explicit submit and skip', () => {
    const html = render(question);
    expect(html).toContain('Which scope?');
    expect(html).toContain('Only this project.');
    expect(html).toContain('Your own answer');
    expect(html).toContain('type="password"');
    expect(html).toContain('Send');
    expect(html).toContain('Close question');
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Skip');
    expect(render(question, true)).toMatch(/<fieldset[^>]*disabled=""/);
  });
  test('requires each question and preserves selected or custom answers by question id', () => {
    expect(() => inputResponse(question, { choice: 'Local' })).toThrow('Answer Details');
    expect(inputResponse(question, { choice: 'Custom scope', text: 'Some details' })).toEqual({
      action: 'accept', answers: { choice: ['Custom scope'], text: ['Some details'] },
    });
  });
  test('combines selected choices and additional details, or sends a custom answer alone', () => {
    expect(inputResponse(question, { choice: 'Local' }, { choice: '추가 설명', text: 'Other details' })).toEqual({
      action: 'accept', answers: { choice: ['Local', '추가 설명'], text: ['Other details'] },
    });
    expect(inputResponse(question, {}, { choice: '다른 선택', text: 'Other details' }).answers?.choice).toEqual(['다른 선택']);
    expect(inputResponse(question, { choice: 'Local' }, { choice: 'Local', text: 'Other details' }).answers?.choice).toEqual(['Local']);
  });
  test('always offers direct input and preserves additional details beside a selected numbered choice', () => {
    if (question.kind !== 'questions') throw new Error('Expected question fixture.');
    const html = renderToStaticMarkup(<ChatQuestionFields questions={[{ ...question.questions[0]!, isOther: false }]}
      draft={{ choice: 'Local' }} notes={{ choice: '추가 설명' }} onChange={() => {}} onNotesChange={() => {}} />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('>1</span>');
    expect(html).toContain('Your own answer');
    expect(html).toContain('추가 설명</textarea>');
    expect(html).not.toContain('required=""');
  });
  test('preserves zero, false and multiple choices as typed values, omitting empty optional inputs', () => {
    const draft = initialInputDraft(form);
    expect(draft).toEqual({ count: '0', enabled: 'false', tags: ['a'] });
    expect(inputResponse(form, { ...draft, note: '' })).toEqual({ action: 'accept', content: { count: 0, enabled: false, tags: ['a'] } });
    expect(() => inputResponse(form, { ...draft, count: '1.2' })).toThrow('valid integer');
    expect(() => inputResponse(form, { ...draft, count: ' ' })).toThrow('valid integer');
    expect(() => inputResponse(form, { ...draft, tags: [] })).toThrow('Enter Tags');
  });
  test('keeps unsupported forms visible and allows cancellation without submitting partial data', () => {
    const unsupported = { ...form, unsupportedReason: 'Nested fields are not supported.' };
    const html = render(unsupported);
    expect(html).toContain(unsupported.unsupportedReason);
    expect(html).toContain('Cancel request');
    expect(html).toContain('Decline');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit<\/button>/);
    expect(() => inputResponse(unsupported, {})).toThrow('Nested fields');
  });
  test('offers an explicit web link and excludes executable or local file links', () => {
    for (const url of ['javascript:alert(1)', 'file:///tmp/secret', 'data:text/html,hello', 'invalid']) expect(userInputLink(url)).toBeNull();
    const html = render({ id: 'url', threadId: 'thread', turnId: null, kind: 'url', serverName: 'Example',
      message: 'Finish in your browser.', url: 'https://example.com/confirm', elicitationId: 'confirm' });
    expect(html).toContain('href="https://example.com/confirm"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Done');
  });
});

describe('failed user message state', () => {
  const pending = () => chatReducer({ ...INITIAL_CHAT_STATE, activeSessionId: 'thread-one' }, {
    type: 'optimistic-user', id: 'client:one', text: 'Hello', title: 'Hello', createdAt: 1,
  });
  test('marks only the affected message and ignores failures for a different conversation', () => {
    const state = pending();
    const action = { type: 'send-failed' as const, clientMessageId: 'one', threadId: 'thread-one', message: 'Rejected' };
    expect(chatReducer(state, { ...action, clientMessageId: 'other' })).toBe(state);
    expect(chatReducer(state, action).items[0]).toMatchObject({ pending: false, delivery: 'failed' });
    expect(chatReducer(state, { ...action, uncertain: true }).items[0]).toMatchObject({ delivery: 'unknown' });
  });
  test('a late authoritative user message acknowledgement clears uncertain delivery without duplication', () => {
    const state = chatReducer(pending(), { type: 'send-failed', clientMessageId: 'one', threadId: 'thread-one', message: 'Disconnected', uncertain: true });
    const event = normalizeChatEvent({ type: 'user-message', threadId: 'thread-one', clientMessageId: 'one', text: 'Hello', createdAt: 1 });
    if (!event) throw new Error('Expected user message event.');
    const confirmed = chatReducer(state, { type: 'event', event });
    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.items[0]).toEqual({ kind: 'user', id: 'client:one', text: 'Hello', createdAt: 1, pending: false });
  });
  test('a late failure cannot stop a newer user response', () => {
    const newer = chatReducer(pending(), { type: 'optimistic-user', id: 'client:two', text: 'Next', title: 'Next', createdAt: 2 });
    const failed = chatReducer(newer, { type: 'send-failed', clientMessageId: 'one', threadId: 'thread-one', message: 'Old failure' });
    expect(failed.phase).toBe(newer.phase);
    expect(failed.responseThreadIds).toEqual(newer.responseThreadIds);
    expect(failed.error).toBe(newer.error);
    expect(failed.items[1]).toEqual(newer.items[1]);
    expect(failed.items[0]).toMatchObject({ delivery: 'failed' });
  });
});
