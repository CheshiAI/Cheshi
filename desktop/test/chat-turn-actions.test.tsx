import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSavedTurnInput } from '../shared/chat-saved-turns';
import type { SavedChatTurnsController } from '../frontend/src/features/chat/useSavedChatTurns';
import type { ChatTimelineItem as TimelineItem } from '../frontend/src/features/chat/model';
import { completedChatTurnInputs } from '../frontend/src/features/chat/chatTurnSnapshots';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatTurnActions } = await import('../frontend/src/features/chat/ChatTurnActions');
const { ChatSavedTurnsSidebar } = await import('../frontend/src/features/chat/ChatSavedTurnsSidebar');
const { ChatTimelineItem } = await import('../frontend/src/features/chat/ChatTimelineItem');

const turn: ChatSavedTurnInput = { threadId: 'thread', itemId: 'answer', sessionTitle: 'Conversation', userText: 'Question', assistantText: '**Answer**', createdAt: 123 };
const savedTurns = (saved = false, saving = false): SavedChatTurnsController => ({
  records: [], loading: false, error: null, refresh: async () => {}, save: async () => true,
  isSaved: () => saved, isSaving: () => saving, dismissError() {},
  remove: async () => true, deleting: false,
});

test('shows copy and save actions and distinguishes saved and in-progress saves', () => {
  const render = (saved: boolean, saving: boolean) => renderToStaticMarkup(<ChatTurnActions turn={turn} savedTurns={savedTurns(saved, saving)} />);
  const html = render(false, false);
  expect(html.indexOf('aria-label="Response statistics"')).toBeGreaterThanOrEqual(0);
  expect(html.indexOf('aria-label="Response statistics"')).toBeLessThan(html.indexOf('aria-label="Response actions"'));
  expect(html).toContain('aria-label="Copy response"');
  expect(html).toContain('aria-label="Save turn"');
  expect(html).toContain('aria-pressed="false"');
  expect(render(true, false)).toContain('aria-label="Turn saved"');
  expect(render(true, false)).toContain('aria-pressed="true" disabled=""');
  expect(render(false, true)).toContain('aria-label="Saving turn…"');
});

test('keeps saved turns on the rail without retired conversation history', () => {
  const html = renderToStaticMarkup(<ChatSavedTurnsSidebar savedTurns={savedTurns()} />);
  const rail = html.slice(html.indexOf('aria-label="Conversation panels"'));
  expect(rail).not.toContain('aria-label="Conversation history"');
  expect(rail).toContain('aria-label="Saved turns"');
  expect(rail.match(/aria-expanded="false"/g)).toHaveLength(1);
});
test('renders one action row after trailing tools and before the next question', () => {
  for (const status of ['completed', 'interrupted', 'failed']) {
    const items: TimelineItem[] = [
      { id: 'question', kind: 'user', text: 'Run a command', createdAt: 1 },
      { id: 'answer', kind: 'assistant', text: 'Starting the command', createdAt: 2 },
      { id: 'command', kind: 'activity', activity: 'command', label: 'Command', detail: 'sleep 45', status },
      { id: 'next', kind: 'user', text: 'Next question', createdAt: 3 },
    ];
    const turns = completedChatTurnInputs(items, 'thread', 'Conversation', true);
    const html = renderToStaticMarkup(<>{items.map((item) => <ChatTimelineItem key={item.id} item={item}
      streaming={false} onReviewFileChanges={() => {}} turn={turns.get(item.id)} savedTurns={savedTurns()} />)}</>);
    const actions = html.indexOf('aria-label="Response actions"');
    expect(actions).toBeGreaterThan(html.indexOf('</details>'));
    expect(actions).toBeLessThan(html.indexOf('Next question'));
    expect(html.match(/aria-label="Response actions"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Response statistics"/g)).toHaveLength(1);
    expect(turns.get('command')?.itemId).toBe('answer');
  }
});

test('saved turns remain usable with refresh, close, Escape and focus restoration', async () => {
  const { withDOM } = await import('./agent-chats-test-dom');
  const { act } = await import('react');
  let refreshed = 0;
  const controller = { ...savedTurns(), refresh: async () => { refreshed++; } };
  await withDOM(async ui => {
    await ui.render(<ChatSavedTurnsSidebar savedTurns={controller} />);
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Saved turns"]')!;
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!.parentElement!;
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(refreshed).toBe(0);
    await ui.click('Saved turns');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(refreshed).toBe(1);
    await ui.click('Refresh saved turns');
    expect(refreshed).toBe(2);
    await ui.click('Close saved turns panel');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    await ui.click('Saved turns');
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close saved turns panel"]')!;
    await act(async () => {
      close.focus();
      close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('button[aria-label="Conversation history"]')).toBeNull();
  });
});
