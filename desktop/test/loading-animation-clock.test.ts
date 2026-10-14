import { expect, test } from 'bun:test';
import { animateLoadingElement, subscribeLoadingFrame } from '../frontend/src/shared/ui/loadingAnimationClock';

function clockHarness() {
  let time = 0, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, FrameRequestCallback>();
  const window = {
    performance: { now: () => time },
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextId; timers.set(id, { at: time + delay, callback }); return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = ++nextId; frames.set(id, callback); return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  return {
    window, timers, frames,
    advance(milliseconds: number) {
      time += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
    },
    paint(timelineOffset = 0) {
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time + timelineOffset));
    },
  };
}

test('visible loaders share one bounded clock and receive the same elapsed time', () => {
  const h = clockHarness();
  const first: number[] = [], second: number[] = [];
  const stopFirst = subscribeLoadingFrame(h.window, time => first.push(time));
  const stopSecond = subscribeLoadingFrame(h.window, time => second.push(time));
  expect(h.timers.size).toBe(1);
  for (let index = 0; index < 20; index++) { h.advance(50); h.paint(); }
  expect(first).toHaveLength(20);
  expect(second).toEqual(first);
  expect(first.at(-1)).toBe(1000);
  stopFirst();
  h.advance(50); h.paint();
  expect(first).toHaveLength(20);
  expect(second.at(-1)).toBe(1050);
  stopSecond();
  expect(h.timers.size).toBe(0);
  expect(h.frames.size).toBe(0);
});

test('a delayed frame skips missed frames instead of catching up in a burst', () => {
  const h = clockHarness(), times: number[] = [];
  const stop = subscribeLoadingFrame(h.window, time => times.push(time));
  h.advance(49); h.paint();
  expect(times).toEqual([]);
  h.advance(5001); h.paint();
  expect(times).toEqual([5050]);
  expect(h.timers.size).toBe(1);
  stop();
});

test('an offset document timeline cannot turn the bounded clock into a refresh-rate loop', () => {
  const h = clockHarness(), times: number[] = [];
  const stop = subscribeLoadingFrame(h.window, time => times.push(time));
  h.advance(50); h.paint(-5000);
  expect(times).toEqual([50]);
  h.advance(16); h.paint(-5000);
  expect(times).toEqual([50]);
  h.advance(34); h.paint(-5000);
  expect(times).toEqual([50, 100]);
  stop();
});

test('last unsubscribe cancels a queued animation frame and allows a fresh subscription', () => {
  const h = clockHarness(), times: number[] = [];
  const stop = subscribeLoadingFrame(h.window, time => times.push(time));
  h.advance(50);
  expect(h.frames.size).toBe(1);
  stop(); stop(); h.paint();
  expect(times).toEqual([]);
  expect(h.frames.size).toBe(0);
  const stopNext = subscribeLoadingFrame(h.window, time => times.push(time));
  stop(); // Old cleanup must not cancel the new clock.
  h.advance(50); h.paint();
  expect(times).toEqual([100]);
  stopNext();
});

test('keyframes advance by wall time, freeze while hidden, and exclude nested indicators', () => {
  const h = clockHarness();
  let pauses = 0;
  const own = { currentTime: 110, effect: { target: { closest: () => element } }, pause() { pauses++; } };
  const nested = { currentTime: 220, effect: { target: { closest: () => ({}) } }, pause() { pauses++; } };
  const element = {
    ownerDocument: { defaultView: h.window }, getAnimations: () => [own, nested],
  };
  // Test only the animation/clock boundary; no browser layout is involved here.
  const target = element as unknown as HTMLElement;
  const stop = animateLoadingElement(target);
  expect(pauses).toBe(1);
  h.advance(50); h.paint();
  expect(own.currentTime).toBe(160);
  expect(nested.currentTime).toBe(220);
  h.advance(2000); h.paint();
  expect(own.currentTime).toBe(2160);
  stop();
  h.advance(5000); h.paint();
  expect(own.currentTime).toBe(2160);
  const resume = animateLoadingElement(target);
  h.advance(50); h.paint();
  expect(own.currentTime).toBe(2210);
  resume();
  expect(h.timers.size).toBe(0);
});
