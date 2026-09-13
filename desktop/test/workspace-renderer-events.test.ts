import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceRendererEvents } from '../lib/workspace-renderer-events.mts';

function fixture() {
  const state = { windowDestroyed: false, contentsDestroyed: false, frameDestroyed: false, detached: false };
  const messages: unknown[][] = [];
  const frame = {
    isDestroyed: () => state.frameDestroyed,
    get detached() { return state.detached; },
    send(channel: string, ...args: unknown[]) { messages.push([channel, ...args]); },
  };
  const window = {
    isDestroyed: () => state.windowDestroyed,
    get webContents() {
      assert.equal(state.windowDestroyed, false, 'must not access a destroyed window');
      return {
        isDestroyed: () => state.contentsDestroyed,
        get mainFrame() {
          assert.equal(state.contentsDestroyed, false, 'must not access destroyed contents');
          return frame;
        },
      };
    },
  };
  return { state, messages, frame, window, events: createWorkspaceRendererEvents() };
}

test('delivers workspace events and arguments to the live main frame', () => {
  const { events, window, messages } = fixture();
  events.send(window, 'account', { state: 'ready' });
  events.send(window, 'git');
  assert.deepEqual(messages, [['account', { state: 'ready' }], ['git']]);
});

for (const unavailable of ['windowDestroyed', 'contentsDestroyed', 'frameDestroyed', 'detached'] as const) {
  test(`skips events when ${unavailable}, including before the window closed event`, () => {
    const { events, window, state, messages } = fixture();
    state[unavailable] = true;
    events.send(window, 'chat', { type: 'failure' });
    assert.deepEqual(messages, []);
  });
}

test('shutdown drops queued account, chat and watcher events without affecting another workspace', () => {
  const closing = fixture();
  const active = fixture();
  closing.events.stop();
  closing.events.stop();
  for (const channel of ['account', 'chat', 'files', 'git', 'diagnostics', 'terminal']) {
    closing.events.send(closing.window, channel);
    active.events.send(active.window, channel);
  }
  assert.deepEqual(closing.messages, []);
  assert.equal(active.messages.length, 6);
});

test('delivery resumes on a live frame if an attempted close or navigation did not destroy the window', () => {
  const { events, window, state, messages } = fixture();
  state.detached = true;
  events.send(window, 'files');
  state.detached = false;
  events.send(window, 'files');
  assert.deepEqual(messages, [['files']]);
});

test('does not suppress unrelated send errors', () => {
  const { events, window, frame } = fixture();
  frame.send = () => { throw new Error('Invalid payload'); };
  assert.throws(() => events.send(window, 'chat'), /Invalid payload/);
});
