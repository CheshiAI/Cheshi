import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { INITIAL_CHAT_STATE, chatReducer, isViewedSessionResponding, type ChatState } from '../frontend/src/features/chat/model';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatTimeline } = await import('../frontend/src/features/chat/ChatTimeline');

function renderTimeline(state: ChatState) {
  return renderToStaticMarkup(<ChatTimeline controller={{
    state, loading: state.phase === 'loading', streaming: isViewedSessionResponding(state),
    pauseAutoScroll() {}, scrollToBottom() {}, showScrollToBottom: false,
    timelineRef: { current: null }, workspaceName: 'Workspace',
  }} onReviewFileChanges={() => {}} />);
}

test('an empty conversation shows only the decorative logo surface without welcome copy', () => {
  const html = renderTimeline(INITIAL_CHAT_STATE);
  expect(html).toContain('data-welcome="true"');
  expect(html).toContain('<canvas');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain('<blockquote');
  expect(html).not.toContain('Lewis Carroll');
  expect(html).not.toContain('How can I help');
  expect(html).not.toContain('You’re up late');
  expect(html).not.toContain('Good morning');
  expect(html.replace(/<[^>]*>/g, '').trim()).toBe('');
});

test('loading and sending replace the logo surface with the conversation content', () => {
  const loading = renderTimeline({ ...INITIAL_CHAT_STATE, phase: 'loading' });
  expect(loading).not.toContain('<canvas');
  expect(loading).toContain('Loading conversation');
  const sent = chatReducer(INITIAL_CHAT_STATE, {
    type: 'optimistic-user', id: 'client:logo', text: 'Start here', title: 'Start here', createdAt: 1,
  });
  const html = renderTimeline(sent);
  expect(html).not.toContain('<canvas');
  expect(html).not.toContain('data-welcome="true"');
  expect(html).toContain('Start here');
  expect(html).toContain('Thinking...');
});

test('shows the shared thinking indicator immediately before a new thread is accepted', () => {
  const state = chatReducer(INITIAL_CHAT_STATE, {
    type: 'optimistic-user', id: 'client:first', text: 'Hello', title: 'Hello', createdAt: 1,
  });
  const html = renderTimeline(state);
  expect(html).toContain('Thinking...');
  expect(html).toContain('0.0s');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('Hello');
});

test('keeps thinking visible while text or tool responses are in progress', () => {
  const state: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread', responseThreadIds: ['thread'],
    phase: 'streaming', items: [
      { id: 'response', kind: 'assistant', text: 'Checking', createdAt: 1 },
      { id: 'tool', kind: 'activity', activity: 'tool', label: 'Inspect', detail: '', status: 'inProgress' },
    ] };
  const html = renderTimeline(state);
  expect(html).toContain('Checking');
  expect(html).toContain('Thinking...');
  expect(renderTimeline({ ...state, responseThreadIds: [], phase: 'idle' })).not.toContain('Thinking...');
});

test('does not show thinking for idle history or a response running in another conversation', () => {
  expect(renderTimeline(INITIAL_CHAT_STATE)).not.toContain('Thinking...');
  const html = renderTimeline({ ...INITIAL_CHAT_STATE, activeSessionId: 'viewed', responseThreadIds: ['other'], phase: 'streaming' });
  expect(html).not.toContain('Thinking...');
  expect(html).toContain('aria-busy="false"');
});

test('history loading keeps its own indicator without showing thinking', () => {
  const html = renderTimeline({ ...INITIAL_CHAT_STATE, phase: 'loading', activeSessionId: 'thread', responseThreadIds: ['thread'] });
  expect(html).toContain('Loading conversation');
  expect(html).not.toContain('Thinking...');
});

test('a failed send removes the thinking indicator', () => {
  const pending = chatReducer(INITIAL_CHAT_STATE, {
    type: 'optimistic-user', id: 'client:first', text: 'Hello', title: 'Hello', createdAt: 1,
  });
  const failed = chatReducer(pending, {
    type: 'send-failed', clientMessageId: 'first', threadId: null, message: 'Connection failed',
  });
  expect(renderTimeline(failed)).not.toContain('Thinking...');
});
