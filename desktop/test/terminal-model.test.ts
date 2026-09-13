import { describe, expect, test } from 'bun:test';

import { normalizeTerminalState } from '../frontend/src/features/terminal/model';

function terminalState(layout: unknown): unknown {
  return {
    available: true,
    error: null,
    cwd: '/Users/developer/projects/example',
    sessions: [{
      id: 'session',
      title: 'Terminal 1',
      panes: [
        { id: 'first', title: '~/projects/example', running: true },
        { id: 'second', title: '~/projects/example', running: true },
      ],
      layout,
    }],
    activeSessionId: 'session',
    activePaneId: 'first',
  };
}

describe('terminal state model', () => {
  test('preserves a valid split id and ratio', () => {
    const state = normalizeTerminalState(terminalState({
      type: 'split',
      id: 'root-split',
      axis: 'columns',
      ratio: 0.65,
      first: { type: 'pane', paneId: 'first' },
      second: { type: 'pane', paneId: 'second' },
    }));

    expect(state?.sessions[0]?.layout).toEqual({
      type: 'split',
      id: 'root-split',
      axis: 'columns',
      ratio: 0.65,
      first: { type: 'pane', paneId: 'first' },
      second: { type: 'pane', paneId: 'second' },
    });
  });

  test('rejects split layouts without a usable persisted ratio', () => {
    expect(normalizeTerminalState(terminalState({
      type: 'split',
      id: 'root-split',
      axis: 'columns',
      first: { type: 'pane', paneId: 'first' },
      second: { type: 'pane', paneId: 'second' },
    }))).toBeNull();
    expect(normalizeTerminalState(terminalState({
      type: 'split',
      id: 'root-split',
      axis: 'columns',
      ratio: 0.95,
      first: { type: 'pane', paneId: 'first' },
      second: { type: 'pane', paneId: 'second' },
    }))).toBeNull();
  });
});
