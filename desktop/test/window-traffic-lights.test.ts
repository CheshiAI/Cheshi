import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createWindowTrafficLights } from '../lib/window-traffic-lights.mts';

function harness() {
  let destroyed = false, fail = false;
  const calls: number[] = [], errors: unknown[] = [];
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => Buffer.alloc(8),
  });
  const controller = createWindowTrafficLights({ window, binding: {
    setWindowTrafficLightScale(_handle: Buffer, scale: number) {
      if (fail) throw new Error('Native failure');
      calls.push(scale);
      return true;
    },
  }, onError: error => errors.push(error) });
  return { window, controller, calls, errors, fail: () => { fail = true; },
    close: () => { destroyed = true; window.emit('closed'); } };
}

async function flushLayout() { await new Promise<void>(resolve => setImmediate(resolve)); }

test('scales on creation and coalesces native layout events after Electron finishes', async () => {
  const h = harness();
  try {
    expect(h.calls).toEqual([0.8]);
    h.window.emit('resize'); h.window.emit('maximize'); h.window.emit('focus');
    expect(h.calls).toEqual([0.8]);
    await flushLayout();
    expect(h.calls).toEqual([0.8, 0.8]);
    for (const event of ['ready-to-show', 'show', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
      h.window.emit(event);
      await flushLayout();
    }
    expect(h.calls).toHaveLength(8);
    expect(h.calls.every(scale => scale === 0.8)).toBe(true);
  } finally { h.controller.dispose(); }
});

test('closing cancels pending work and removes listeners without accessing the destroyed window', async () => {
  const h = harness();
  h.window.emit('resize');
  h.close();
  await flushLayout();
  expect(h.calls).toEqual([0.8]);
  expect(h.window.eventNames()).toEqual([]);
  h.controller.dispose();
  expect(h.calls).toEqual([0.8]);
});

test('explicit disposal restores the original geometry once', async () => {
  const h = harness();
  h.window.emit('resize');
  h.controller.dispose(); h.controller.dispose();
  await flushLayout();
  expect(h.calls).toEqual([0.8, 1]);
  expect(h.window.eventNames()).toEqual([]);
});

test('unavailable native support leaves the window untouched', () => {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getNativeWindowHandle: (): Buffer => { throw new Error('Must not access native window'); },
  });
  const controller = createWindowTrafficLights({ window, binding: null,
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
