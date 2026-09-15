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

test('groups today separately and combines all earlier chats under Previous in their existing order', () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1_000;
  const html = renderSessions([today, today - 1, today - 30 * 24 * 60 * 60, NaN]);
  expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1])).toEqual(['Today', 'Previous']);
  const boundary = html.indexOf('<h2>Previous</h2>');
  expect(html.indexOf('title="Chat 0"')).toBeLessThan(boundary);
  let previous = boundary;
  for (const index of [1, 2, 3]) {
    const position = html.indexOf(`title="Chat ${index}"`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
});

test('omits empty groups', () => {
  expect(renderSessions([])).not.toContain('<h2>');
  const html = renderSessions([0]);
  expect(html).toContain('<h2>Previous</h2>');
  expect(html).not.toContain('<h2>Today</h2>');
});

test('places conversation search below the header and above session groups', () => {
  const html = renderSessions([Date.now() / 1_000]);
  const search = html.indexOf('aria-label="Conversation search"');
  expect(search).toBeGreaterThan(html.indexOf('</header>'));
  expect(search).toBeLessThan(html.indexOf('<h2>Today</h2>'));
});

test('hides only the search when there are no sessions, including while loading', () => {
  for (const loading of [false, true]) {
    const html = renderSessions([], loading);
    expect(html).not.toContain('aria-label="Conversation search"');
    expect(html).toContain('CHATS');
    expect(html).toContain('aria-label="New chat"');
  }
  expect(renderSessions([0], true)).toContain('aria-label="Conversation search"');
});
