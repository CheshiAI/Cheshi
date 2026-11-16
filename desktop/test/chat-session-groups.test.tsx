import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import type { ChatSession } from '../frontend/src/features/chat/model';

function renderSessions(timestamps: number[], loading = false) {
  const sessions: ChatSession[] = timestamps.map((updatedAt, index) => ({
    id: `session-${index}`, title: `Chat ${index}`, preview: '', createdAt: updatedAt, updatedAt, status: 'idle',
  }));
  return renderToStaticMarkup(<ChatSessionList sessions={sessions} loading={loading}
    search={<input aria-label="Conversation search" />}
    activeSessionId={null} responseThreadIds={[]} newChatDisabled={false} selectionDisabled={false}
    onOpen={() => {}} onNew={() => {}} onDelete={() => {}} deleteReason={() => null} />);
}

test('combines all sessions in newest activity order with invalid timestamps last', () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1_000;
  const html = renderSessions([today - 1, NaN, today, today - 30 * 24 * 60 * 60, today]);
  expect(html).not.toContain('<h2>');
  let previous = -1;
  for (const index of [2, 4, 0, 3, 1]) {
    const position = html.indexOf(`aria-label="Chat ${index}"`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
});

test('shows session ids and elapsed time without group headings', () => {
  expect(renderSessions([])).not.toContain('<h2>');
  const html = renderSessions([0]);
  expect(html).not.toContain('<h2>');
  expect(html).toContain('aria-description="session-0">session-0</span>');
  expect(html).toContain('aria-label="Last updated ');
});

test('places conversation search below the header and above the session list', () => {
  const html = renderSessions([Date.now() / 1_000]);
  const search = html.indexOf('aria-label="Conversation search"');
  expect(search).toBeGreaterThan(html.indexOf('</header>'));
  expect(search).toBeLessThan(html.indexOf('aria-label="Chat 0"'));
});

test('hides only the search when there are no sessions, including while loading', () => {
  for (const loading of [false, true]) {
    const html = renderSessions([], loading);
    expect(html).not.toContain('aria-label="Conversation search"');
    expect(html).toContain('SESSION');
    expect(html).toContain('aria-label="New chat"');
  }
  expect(renderSessions([0], true)).toContain('aria-label="Conversation search"');
});
