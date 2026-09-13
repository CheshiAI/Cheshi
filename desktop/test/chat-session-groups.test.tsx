import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import type { ChatSession } from '../frontend/src/features/chat/model';

function renderSessions(timestamps: number[]) {
  const sessions: ChatSession[] = timestamps.map((updatedAt, index) => ({
    id: `session-${index}`, title: `Chat ${index}`, preview: '', createdAt: updatedAt, updatedAt, status: 'idle',
  }));
  return renderToStaticMarkup(<ChatSessionList sessions={sessions} loading={false}
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
