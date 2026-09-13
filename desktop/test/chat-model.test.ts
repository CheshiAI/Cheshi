import { describe, expect, test } from 'bun:test';

import {
  INITIAL_CHAT_STATE,
  chatReducer,
  isViewedSessionResponding,
  normalizeOpenSessionResponse,
} from '../frontend/src/features/chat/model.ts';
import type { ChatSession } from '../frontend/src/features/chat/model.ts';

function session(id: string): ChatSession {
  return {
    id,
    title: id,
    preview: id,
    createdAt: 100,
    updatedAt: 110,
    status: 'idle',
  };
}

describe('chat session response state', () => {
  test('tracks the responding thread separately from the viewed session', () => {
    const response = normalizeOpenSessionResponse({
      session: session('history-thread'),
      items: [],
      responseInProgress: true,
      responseThreadIds: ['running-thread'],
    });
    const state = chatReducer(INITIAL_CHAT_STATE, { type: 'session-opened', ...response });

    expect(state.phase).toBe('streaming');
    expect(state.activeSessionId).toBe('history-thread');
    expect(state.responseThreadIds).toEqual(['running-thread']);
    expect(isViewedSessionResponding(state)).toBe(false);

    const runningSession = chatReducer(state, {
      type: 'session-opened',
      session: session('running-thread'),
      items: [],
      responseInProgress: true,
      responseThreadIds: ['running-thread'],
    });
    expect(isViewedSessionResponding(runningSession)).toBe(true);
  });

  test('completing one session leaves another parallel response active', () => {
    let opened = chatReducer(INITIAL_CHAT_STATE, {
      type: 'session-opened',
      session: session('second-thread'),
      items: [],
      responseInProgress: true,
      responseThreadIds: ['first-thread', 'second-thread'],
    });
    opened = chatReducer(opened, {
      type: 'event',
      event: {
        type: 'assistant-delta',
        threadId: 'first-thread',
        itemId: 'background-message',
        text: 'Background text',
        createdAt: 120,
      },
    });
    expect(opened.items).toEqual([]);

    const completed = chatReducer(opened, {
      type: 'event',
      event: {
        type: 'turn-completed',
        threadId: 'first-thread',
        status: 'completed',
        message: null,
      },
    });

    expect(completed.phase).toBe('streaming');
    expect(completed.responseThreadIds).toEqual(['second-thread']);
    expect(isViewedSessionResponding(completed)).toBe(true);
  });
});
