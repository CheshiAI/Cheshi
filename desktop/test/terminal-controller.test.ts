import assert from 'node:assert/strict';
import test from 'node:test';

import {
  insertTerminalPane,
  removeTerminalPane,
  resizeTerminalSplit,
  TerminalController,
} from '../lib/terminal-controller.mts';

type TerminalState = ReturnType<TerminalController['snapshot']>;
type TerminalLayout = Parameters<typeof insertTerminalPane>[0];
type TerminalSession = TerminalState['sessions'][number];
type TerminalSplitLayout = Extract<NonNullable<TerminalSession['layout']>, { type: 'split' }>;

function latestState(states: TerminalState[]): TerminalState {
  const state = states.at(-1);
  if (!state) throw new Error('Expected the terminal controller to emit state.');
  return state;
}

function firstSession(state: TerminalState): TerminalSession {
  const session = state.sessions[0];
  if (!session) throw new Error('Expected a terminal session.');
  return session;
}

function splitLayout(session: TerminalSession): TerminalSplitLayout {
  const { layout } = session;
  if (layout?.type !== 'split') throw new Error('Expected a split terminal layout.');
  return layout;
}

function createController() {
  const states: TerminalState[] = [];
  const controller = new TerminalController({
    onStateChanged(state) {
      states.push(state as TerminalState);
    },
  });
  return { controller, states };
}

test('inserts panes on the requested side and axis', () => {
  const initial: TerminalLayout = { type: 'pane', paneId: 'first' };
  assert.deepEqual(insertTerminalPane(initial, 'first', 'right', 'right', 'split-right'), {
    type: 'split',
    id: 'split-right',
    axis: 'columns',
    ratio: 0.5,
    first: initial,
    second: { type: 'pane', paneId: 'right' },
  });
  assert.deepEqual(insertTerminalPane(initial, 'first', 'left', 'left', 'split-left'), {
    type: 'split',
    id: 'split-left',
    axis: 'columns',
    ratio: 0.5,
    first: { type: 'pane', paneId: 'left' },
    second: initial,
  });
  assert.deepEqual(insertTerminalPane(initial, 'first', 'down', 'down', 'split-down'), {
    type: 'split',
    id: 'split-down',
    axis: 'rows',
    ratio: 0.5,
    first: initial,
    second: { type: 'pane', paneId: 'down' },
  });
  assert.deepEqual(insertTerminalPane(initial, 'first', 'up', 'up', 'split-up'), {
    type: 'split',
    id: 'split-up',
    axis: 'rows',
    ratio: 0.5,
    first: { type: 'pane', paneId: 'up' },
    second: initial,
  });
});

test('removing a pane collapses its parent split', () => {
  const layout: TerminalLayout = {
    type: 'split',
    id: 'outer',
    axis: 'columns',
    ratio: 0.5,
    first: { type: 'pane', paneId: 'first' },
    second: {
      type: 'split',
      id: 'inner',
      axis: 'rows',
      ratio: 0.5,
      first: { type: 'pane', paneId: 'second' },
      second: { type: 'pane', paneId: 'third' },
    },
  };
  assert.deepEqual(removeTerminalPane(layout, 'second'), {
    type: 'split',
    id: 'outer',
    axis: 'columns',
    ratio: 0.5,
    first: { type: 'pane', paneId: 'first' },
    second: { type: 'pane', paneId: 'third' },
  });
});

test('updates only the requested nested split ratio', () => {
  const layout: TerminalLayout = {
    type: 'split',
    id: 'outer',
    axis: 'columns',
    ratio: 0.5,
    first: { type: 'pane', paneId: 'first' },
    second: {
      type: 'split',
      id: 'inner',
      axis: 'rows',
      ratio: 0.5,
      first: { type: 'pane', paneId: 'second' },
      second: { type: 'pane', paneId: 'third' },
    },
  };

  assert.deepEqual(resizeTerminalSplit(layout, 'inner', 0.65), {
    ...layout,
    second: { ...layout.second, ratio: 0.65 },
  });
  assert.equal(resizeTerminalSplit(layout, 'missing', 0.65), layout);
  assert.equal(resizeTerminalSplit(layout, 'outer', 0.05), layout);
});

test('manages terminal sessions and pane metadata', () => {
  const { controller, states } = createController();
  assert.equal(controller.open('/tmp/cheshi-terminal'), true);

  const initialSession = firstSession(latestState(states));
  const firstPane = initialSession.panes[0];
  if (!firstPane) throw new Error('Expected the initial terminal pane.');
  const sessionId = initialSession.id;
  const firstPaneId = firstPane.id;

  const secondPaneId = controller.splitPane(sessionId, firstPaneId, 'right');
  const splitSession = firstSession(latestState(states));
  const initialSplitLayout = splitLayout(splitSession);
  assert.equal(splitSession.panes.length, 2);
  assert.equal(initialSplitLayout.axis, 'columns');
  assert.equal(initialSplitLayout.ratio, 0.5);

  assert.equal(controller.resizeSplit(sessionId, initialSplitLayout.id, 0.7), true);
  assert.equal(splitLayout(firstSession(latestState(states))).ratio, 0.7);

  assert.equal(controller.closePane(sessionId, secondPaneId), true);
  const collapsedState = latestState(states);
  const collapsedSession = firstSession(collapsedState);
  assert.equal(collapsedSession.panes.length, 1);
  assert.equal(collapsedSession.layout?.type, 'pane');
  assert.equal(collapsedState.activePaneId, firstPaneId);

  controller.newSession();
  assert.equal(latestState(states).sessions.length, 2);
  controller.close();
  assert.equal(latestState(states).sessions.length, 0);
});

test('does not emit state when the active native pane reports focus again', () => {
  const { controller, states } = createController();
  controller.open('/tmp/cheshi-terminal');
  const state = latestState(states);
  const stateCount = states.length;

  assert.equal(controller.selectPane(state.activeSessionId, state.activePaneId), true);
  assert.equal(states.length, stateCount);
});

test('reuses the latest closed terminal session number', () => {
  const { controller, states } = createController();
  controller.open('/tmp/cheshi-terminal');
  controller.newSession();

  const secondSession = latestState(states).sessions.find((session) => session.title === 'Terminal 2');
  if (!secondSession) throw new Error('Expected a second terminal session.');
  controller.closeSession(secondSession.id);
  controller.newSession();

  assert.deepEqual(latestState(states).sessions.map((session) => session.title), [
    'Terminal 1',
    'Terminal 2',
  ]);
});

test('applies native surface titles and removes an exited pane', () => {
  const { controller, states } = createController();
  controller.open('/tmp/cheshi-terminal');
  const paneId = latestState(states).activePaneId;

  assert.equal(controller.setPaneTitle(paneId, 'native ghostty'), true);
  const titledPane = firstSession(latestState(states)).panes[0];
  assert.equal(titledPane?.title, 'native ghostty');

  assert.equal(controller.handleSurfaceExit(paneId), true);
  assert.equal(latestState(states).sessions.length, 0);
});
