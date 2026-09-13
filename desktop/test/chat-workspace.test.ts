import { describe, expect, test } from 'bun:test';
import { chatForkUnavailableReason, chatHistoryForkUnavailableReason, closeChatPane, createChatWorkspace, resizeChatPane, splitChatPane } from '../frontend/src/features/chat/chatWorkspaceModel';
import { splitPaneIds } from '../frontend/src/shared/ui/splitPaneModel';
import { chatReducer, INITIAL_CHAT_STATE } from '../frontend/src/features/chat/model';

describe('chat workspace', () => {
  test('history forks can open in an empty pane but require idle source and destination', () => {
    const ready = { ...INITIAL_CHAT_STATE, phase: 'idle' as const };
    expect(chatHistoryForkUnavailableReason(ready, false, false)).toBeNull();
    expect(chatHistoryForkUnavailableReason(ready, false, true)).toContain('selected conversation');
    expect(chatHistoryForkUnavailableReason(ready, true, false)).toContain('relay');
    expect(chatHistoryForkUnavailableReason(undefined, false, false)).toContain('unavailable');
    expect(chatHistoryForkUnavailableReason({ ...ready, phase: 'loading' }, false, false)).not.toBeNull();
    expect(chatHistoryForkUnavailableReason({ ...ready, responseThreadIds: ['destination'] }, false, false)).not.toBeNull();
  });
  test('fork requires a ready saved conversation outside a relay', () => {
    const ready = { ...INITIAL_CHAT_STATE, activeSessionId: 'source', phase: 'idle' as const };
    expect(chatForkUnavailableReason(ready, false)).toBeNull();
    expect(chatForkUnavailableReason(ready, true)).toContain('relay');
    expect(chatForkUnavailableReason(undefined, false)).toContain('Send a message');
    expect(chatForkUnavailableReason(INITIAL_CHAT_STATE, false)).toContain('Send a message');
    expect(chatForkUnavailableReason({ ...ready, phase: 'loading' }, false)).not.toBeNull();
    expect(chatForkUnavailableReason({ ...ready, phase: 'streaming' }, false)).not.toBeNull();
    expect(chatForkUnavailableReason({ ...ready, pendingNewResponse: true }, false)).not.toBeNull();
    expect(chatForkUnavailableReason({ ...ready, responseThreadIds: ['other'] }, false)).not.toBeNull();
    expect(chatForkUnavailableReason({ ...ready, approvals: [{ id: 'approval', threadId: 'source', kind: 'command',
      title: 'Run', detail: '', canAllowForSession: false }] }, false)).not.toBeNull();
  });
  test('nested splits retain existing pane identities and focus the new pane', () => {
    const initial = createChatWorkspace('first');
    const right = splitChatPane(initial, 'first', 'second', 'right', 'columns');
    const down = splitChatPane(right, 'first', 'third', 'down', 'rows');
    expect(splitPaneIds(down.layout)).toEqual(['first', 'third', 'second']);
    expect(down.activePaneId).toBe('third');
    const resized = resizeChatPane(down, 'columns', 0.7);
    expect(splitPaneIds(resized.layout)).toEqual(['first', 'third', 'second']);
    expect(resized.activePaneId).toBe('third');
    expect(resized.layout).toMatchObject({ axis: 'columns', ratio: 0.7 });
    expect(initial.layout).toEqual({ type: 'pane', paneId: 'first' });
  });

  test('closing active and inactive panes chooses a surviving neighbor without replacing it', () => {
    const split = splitChatPane(createChatWorkspace('first'), 'first', 'second', 'right', 'split');
    const inactiveClosed = closeChatPane(split, 'first', 'unused');
    expect(inactiveClosed).toEqual(createChatWorkspace('second'));
    const activeClosed = closeChatPane(split, 'second', 'unused');
    expect(activeClosed).toEqual(createChatWorkspace('first'));
    expect(closeChatPane(split, 'missing', 'unused')).toBe(split);
  });

  test('closing the final pane starts a fresh context, while retained history is outside layout state', () => {
    expect(closeChatPane(createChatWorkspace('closed'), 'closed', 'fresh'))
      .toEqual(createChatWorkspace('fresh'));
  });

  test('interleaved pane responses maintain separate timelines and completion state', () => {
    const thread = (id: string) => chatReducer(INITIAL_CHAT_STATE, {
      type: 'event', event: { type: 'session-selected', threadId: id },
    });
    let left = chatReducer(thread('left'), { type: 'event', event: { type: 'turn-started', threadId: 'left' } });
    let right = chatReducer(thread('right'), { type: 'event', event: { type: 'turn-started', threadId: 'right' } });
    left = chatReducer(left, { type: 'event', event: { type: 'assistant-delta', threadId: 'left', itemId: 'same-item', text: 'Left', createdAt: 1 } });
    right = chatReducer(right, { type: 'event', event: { type: 'assistant-delta', threadId: 'right', itemId: 'same-item', text: 'Right', createdAt: 1 } });
    left = chatReducer(left, { type: 'event', event: { type: 'turn-completed', threadId: 'left', status: 'completed', message: null } });
    expect(left.responseThreadIds).toEqual([]);
    expect(right.responseThreadIds).toEqual(['right']);
    expect(left.items).toMatchObject([{ text: 'Left' }]);
    expect(right.items).toMatchObject([{ text: 'Right' }]);
  });
});
