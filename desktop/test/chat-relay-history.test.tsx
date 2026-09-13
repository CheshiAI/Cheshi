import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRelayHistoryRecord, ChatRelayState } from '../shared/chat-relay';
import type { ChatRelayController } from '../frontend/src/features/chat/useChatRelay';
import type { ChatWorkspaceController } from '../frontend/src/features/chat/useChatWorkspace';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatRelayStatus } = await import('../frontend/src/features/chat/ChatRelayControls');
const { ChatRelayHistoryPanel } = await import('../frontend/src/features/chat/ChatRelayHistoryPanel');

const completed: ChatRelayState = {
  id: 'saved', sourceContextId: 'a', sourceThreadId: 'thread-a', targetContextId: 'b', targetThreadId: 'thread-b',
  mode: 'debate', maxRounds: 2, round: 2, step: 4, speaker: 'B', phase: 'discussion', status: 'completed',
  outcome: 'debated', proposalVersion: null, proposal: null, issues: [], summary: '**Saved result**', message: null,
};
const record: ChatRelayHistoryRecord = { id: 'saved', objective: 'Compare the input layouts', startedAt: '2026-09-08T01:00:00.000Z',
  updatedAt: '2026-09-08T01:02:00.000Z', finishedAt: '2026-09-08T01:02:00.000Z', state: completed };

function relayFixture(overrides: Partial<ChatRelayController> = {}): ChatRelayController {
  // The static rendering boundary does not mount IPC-backed hooks.
  return { state: completed, displayedState: completed, selectedResult: null, resultVisible: true,
    error: null, pending: false, running: false, history: [record], historyLoading: false, historyError: null, historyDeleting: false, deleteHistory: async () => true,
    dismissError() {}, dismissResult() {}, showResult() {}, showLiveResult() {},
    refreshHistory: async () => {}, start: async () => true, stop: async () => true, ...overrides };
}
const renderStatus = (relay: ChatRelayController) => renderToStaticMarkup(<ChatRelayStatus workspace={{ relay } as ChatWorkspaceController} />);

describe('conversation history presentation', () => {
  test('viewing a saved result cannot expose the stop control for a different live conversation', () => {
    const state = { ...completed, id: 'live', status: 'running' as const, outcome: null };
    const html = renderStatus(relayFixture({ state, running: true, selectedResult: record }));
    expect(html).toContain('Compare the input layouts');
    expect(html).toContain('<strong>Saved result</strong>');
    expect(html).toContain('Show current conversation');
    expect(html).not.toContain('Stop all');
  });

  test('live results retain cancellation while a completed result can be hidden', () => {
    const state = { ...completed, id: 'live', status: 'running' as const, outcome: null };
    expect(renderStatus(relayFixture({ state, displayedState: state, running: true }))).toContain('Stop all');
    expect(renderStatus(relayFixture())).toContain('Dismiss conversation status');
    expect(renderStatus(relayFixture({ displayedState: null, resultVisible: false }))).toBe('');
  });

  test('keeps saved records and the current result available in the mounted closed panel', () => {
    const html = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relayFixture({ displayedState: null, resultVisible: false })} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).not.toContain('Latest conversation');
    expect(html).toContain('Compare the input layouts');
    expect(html).toContain('2026-09-08T01:02:00.000Z');
    expect(html).toContain('Debate');
  });

  test('offers a separate deletion control for persisted records only', () => {
    const html = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relayFixture()} />);
    expect(html).toContain('aria-label="Delete conversation history: Compare the input layouts"');
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    const live = { ...completed, status: 'running' as const };
    const running = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relayFixture({ state: live, running: true })} />);
    expect(running).toContain('Current conversation');
    expect(running).not.toContain('aria-label="Delete conversation history:');
    const unsaved = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relayFixture({ history: [] })} />);
    expect(unsaved).not.toContain('aria-label="Delete conversation history:');
  });

  test('retains an unsaved latest result as a reopenable entry', () => {
    const html = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relayFixture({ history: [], resultVisible: false })} />);
    expect(html).toContain('Latest conversation');
    expect(html).toContain('Conversation history');
  });

  test('shows recoverable history loading errors without discarding available records', () => {
    const html = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relayFixture({ historyError: 'Cannot read saved history.' })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Retry');
    expect(html).toContain('Compare the input layouts');
  });

  test('shows persistence failures on the live result', () => {
    const state = { ...completed, historyError: 'Could not save conversation history.' };
    expect(renderStatus(relayFixture({ state, displayedState: state }))).toContain('Could not save conversation history.');
  });

  test('identifies moderator synthesis and preserves cancellation for its live turn', () => {
    const state: ChatRelayState = { ...completed, status: 'running', outcome: null, speaker: 'C', phase: 'synthesis',
      step: 5, moderatorContextId: 'c', moderatorThreadId: 'moderator-thread-c' };
    const html = renderStatus(relayFixture({ state, displayedState: state, running: true }));
    expect(html).toContain('C summarizing');
    expect(html).toContain('moderator-thread-c');
    expect(html).toContain('Stop all');
    expect(html).toContain('Moderator summary and remaining differences');
    expect(html).not.toContain('Agreement reached');
  });

  test('includes the moderator in saved history while keeping legacy final reviews distinct', () => {
    const state: ChatRelayState = { ...completed, speaker: 'C', phase: 'synthesis', step: 5,
      moderatorContextId: 'c', moderatorThreadId: 'moderator-thread-c' };
    const saved = { ...record, state };
    const relay = relayFixture({ state, displayedState: state, selectedResult: saved, history: [saved] });
    const html = renderToStaticMarkup(<ChatRelayHistoryPanel relay={relay} />);
    expect(html).toContain('moderator-thread-c');
    expect(html).toContain('C · moderato…ad-c');
    expect(renderStatus(relay)).toContain('Moderator summary and remaining differences');
    expect(renderStatus(relayFixture())).toContain('Final review and remaining differences');
    expect(renderStatus(relayFixture())).not.toContain('Moderator summary');
  });
});
