import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createWindowTopHighlight } from '../lib/window-top-highlight.mts';

function harness() {
  let destroyed = false, fail = false;
  const calls: boolean[] = [], errors: unknown[] = [];
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => Buffer.alloc(8),
  });
  const controller = createWindowTopHighlight({ window, binding: {
    setWindowTopHighlightHidden(_handle: Buffer, hidden: boolean) {
      if (fail) throw new Error('Native failure');
      calls.push(hidden);
      return true;
    },
  }, onError: error => errors.push(error) });
  return { window, controller, calls, errors, fail: () => { fail = true; },
    close: () => { destroyed = true; window.emit('closed'); } };
}

async function flushLayout() { await new Promise<void>(resolve => setImmediate(resolve)); }

test('hides the highlight on creation and coalesces native layout events after Electron finishes', async () => {
  const h = harness();
  try {
    expect(h.calls).toEqual([true]);
    h.window.emit('resize'); h.window.emit('maximize'); h.window.emit('focus');
    expect(h.calls).toEqual([true]);
    await flushLayout();
    expect(h.calls).toEqual([true, true]);
    for (const event of ['ready-to-show', 'show', 'enter-full-screen', 'leave-full-screen']) {
      h.window.emit(event);
      await flushLayout();
    }
    expect(h.calls).toHaveLength(6);
    expect(h.calls.every(hidden => hidden === true)).toBe(true);
  } finally { h.controller.dispose(); }
});

test('closing cancels pending work and removes listeners without accessing the destroyed window', async () => {
  const h = harness();
  h.window.emit('resize');
  h.close();
  await flushLayout();
  expect(h.calls).toEqual([true]);
  expect(h.window.eventNames()).toEqual([]);
  h.controller.dispose();
  expect(h.calls).toEqual([true]);
});

test('explicit disposal restores the original decoration visibility once', async () => {
  const h = harness();
  h.window.emit('resize');
  h.controller.dispose(); h.controller.dispose();
  await flushLayout();
  expect(h.calls).toEqual([true, false]);
  expect(h.window.eventNames()).toEqual([]);
});

test('unavailable native support leaves the window untouched', () => {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getNativeWindowHandle: (): Buffer => { throw new Error('Must not access native window'); },
  });
  const controller = createWindowTopHighlight({ window, binding: null,
    onError: () => { throw new Error('Unexpected error'); } });
  expect(window.eventNames()).toEqual([]);
  controller.dispose();
});

test('native errors are reported without interrupting window events', async () => {
  const h = harness();
  h.fail();
  h.window.emit('resize');
  await flushLayout();
  expect(h.errors).toHaveLength(1);
  expect((h.errors[0] as Error).message).toBe('Native failure');
  h.close();
});
