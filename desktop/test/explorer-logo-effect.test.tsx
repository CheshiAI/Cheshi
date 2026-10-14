import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountCheshiLogoEffect } from '../frontend/src/shared/ui/cheshiLogoAnimation';

interface Draw { alpha: number; args: unknown[] }
function drawingContext() {
  const draws: Draw[] = [];
  const text: Draw[] = [];
  const pixels = new Uint8ClampedArray(84 * 56 * 4);
  // Solid logo, transparent background, black cutout, and shaded logo.
  pixels.set([255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 128, 128, 128, 255]);
  return { draws, text, globalAlpha: 1, font: '', fillStyle: '', textBaseline: '', clears: 0,
    drawImage(...args: unknown[]) { draws.push({ alpha: this.globalAlpha, args }); },
    fillText(...args: unknown[]) { text.push({ alpha: this.globalAlpha, args }); },
    clearRect() { this.clears++; }, setTransform() {},
    getImageData() { return { data: pixels }; },
  };
}

async function withEffect(run: (h: ReturnType<typeof fixture>) => void) {
  const h = fixture();
  try { run(h); } finally { h.dispose(); await h.window.happyDOM.close(); }
}

function fixture() {
  const window = new Window();
  const document = window.document;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  let now = 0;
  let frameId = 0;
  let hidden = false;
  let laidOut = true;
  let resized: () => void = () => {};
  let intersected: (visible: boolean) => void = () => {};
  let resizeDisconnected = false;
  let intersectionDisconnected = false;
  let rect = { left: 100, top: 50, width: 800, height: 600 };
  const frames = new Map<number, FrameRequestCallback>();
  const contexts: ReturnType<typeof drawingContext>[] = [];
  class Image {
    src = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { images.push(this); }
  }
  const images: Image[] = [];
  const motion = new window.EventTarget();
  let reduced = false;
  Object.defineProperty(motion, 'matches', { get: () => reduced });
  Object.defineProperties(window, {
    Image: { value: Image },
    ResizeObserver: { value: class {
      constructor(callback: () => void) { resized = callback; }
      observe() {} disconnect() { resizeDisconnected = true; }
    } },
    IntersectionObserver: { value: class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersected = visible => callback([{ isIntersecting: visible }]);
      }
      observe() {} disconnect() { intersectionDisconnected = true; }
    } },
    matchMedia: { value: () => motion },
    devicePixelRatio: { value: 2 },
    requestAnimationFrame: { value: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; } },
    cancelAnimationFrame: { value: (id: number) => frames.delete(id) },
  });
  Object.defineProperty(window.performance, 'now', { value: () => now });
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  Object.defineProperties(host, {
    getBoundingClientRect: { value: () => rect },
    getClientRects: { value: () => laidOut ? [rect] : [] },
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: function () {
    const context = drawingContext(); contexts.push(context); return context;
  } });
  const dispose = mountCheshiLogoEffect(host as unknown as HTMLElement, canvas as unknown as HTMLCanvasElement, '/logo.png');
  return { window, canvas, images, contexts, frames, dispose,
    get disconnected() { return resizeDisconnected && intersectionDisconnected; },
    click(x = 300, y = 200, options: { button?: number; isPrimary?: boolean; prevented?: boolean } = {}) {
      const event = new window.PointerEvent('pointerdown', {
        clientX: x, clientY: y, button: options.button ?? 0, isPrimary: options.isPrimary ?? true,
        bubbles: true, cancelable: true,
      });
      if (options.prevented) event.preventDefault();
      host.dispatchEvent(event);
      return event.defaultPrevented;
    },
    load() { images[0]!.onload?.(); },
    step(time: number) {
      now = time;
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time));
    },
    resize(width: number, height: number) { rect = { ...rect, width, height }; resized(); },
    hideDocument(value: boolean) { hidden = value; document.dispatchEvent(new window.Event('visibilitychange')); },
    hideLayout() { laidOut = false; },
    intersect(visible: boolean) { intersected(visible); },
    reduce(value: boolean) { reduced = value; motion.dispatchEvent(new window.Event('change')); },
    blur() { window.dispatchEvent(new window.Event('blur')); },
  };
}

test('builds ASCII only inside the logo and animates at local click coordinates without cancelling input', async () => {
  await withEffect(h => {
    expect(h.frames.size).toBe(0);
    h.load();
    expect(h.images[0]!.src).toBe('/logo.png');
    const texture = h.contexts[2]!;
    expect(texture.text.map(draw => draw.args.slice(1))).toEqual([[0, 0], [18, 0]]);
    expect(texture.text.every(draw => draw.alpha > 0 && draw.alpha <= 1)).toBe(true);
    expect(h.click()).toBe(false);
    expect(h.frames.size).toBe(1);
    h.step(200);
    const first = h.contexts[0]!.draws.at(-1)!;
    const [, x, y, width] = first.args as [unknown, number, number, number];
    expect(x + width / 2).toBeCloseTo(200);
    expect(y + width / 2).toBeCloseTo(150);
    h.step(1200);
    const later = h.contexts[0]!.draws.at(-1)!;
    expect(later.args[3] as number).toBeGreaterThan(width);
    expect(later.alpha).toBeLessThan(first.alpha);
    h.step(2400);
    expect(h.frames.size).toBe(0);
  });
});

test('caps overlapping clicks, preserves independent positions and ignores secondary or cancelled input', async () => {
  await withEffect(h => {
    h.load();
    h.click(300, 200, { button: 2 });
    h.click(300, 200, { isPrimary: false });
    h.click(300, 200, { prevented: true });
    expect(h.frames.size).toBe(0);
    for (let index = 0; index < 20; index++) h.click(150 + index * 10, 200);
    expect(h.frames.size).toBe(1);
    h.step(200);
    const draws = h.contexts[0]!.draws;
    expect(draws).toHaveLength(6);
    draws.forEach((draw, index) => {
      expect(Number(draw.args[1]) + Number(draw.args[3]) / 2).toBeCloseTo(190 + index * 10);
    });
    expect(h.contexts).toHaveLength(3);
  });
});

test('loading, resizing and large displays keep one bounded canvas and end at idle', async () => {
  await withEffect(h => {
    h.click();
    expect(h.frames.size).toBe(0);
    h.load();
    expect(h.frames.size).toBe(1);
    h.resize(1600, 1200);
    expect(h.canvas.width * h.canvas.height).toBeLessThan(4_010_000);
    h.step(200);
    const draw = h.contexts[0]!.draws.at(-1)!;
    expect(Number(draw.args[1]) + Number(draw.args[3]) / 2).toBeCloseTo(400);
    expect(Number(draw.args[2]) + Number(draw.args[4]) / 2).toBeCloseTo(300);
    h.resize(0, 0);
    expect(h.frames.size).toBe(0);
    h.click();
    expect(h.frames.size).toBe(0);
  });
});

test.each(['document', 'intersection', 'layout', 'blur', 'motion'] as const)('%s hiding clears effects without replaying old clicks', async mode => {
  await withEffect(h => {
    h.load(); h.click(); h.step(200);
    const clears = h.contexts[0]!.clears;
    if (mode === 'document') h.hideDocument(true);
    if (mode === 'intersection') h.intersect(false);
    if (mode === 'layout') { h.hideLayout(); h.step(300); }
    if (mode === 'blur') h.blur();
    if (mode === 'motion') h.reduce(true);
    expect(h.frames.size).toBe(0);
    expect(h.contexts[0]!.clears).toBeGreaterThan(clears);
    h.hideDocument(false); h.intersect(true); h.reduce(false);
    expect(h.frames.size).toBe(0);
  });
});

test('reduced motion skips decoration and cleanup removes pending frames, observers and late image work', async () => {
  await withEffect(h => {
    h.reduce(true); h.load(); h.click();
    expect(h.frames.size).toBe(0);
    h.reduce(false); h.click();
    expect(h.frames.size).toBe(1);
    const lateLoad = h.images[0]!.onload;
    h.dispose();
    expect(h.disconnected).toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.images[0]!.onload).toBeNull();
    expect(h.images[0]!.onerror).toBeNull();
    h.click(); lateLoad?.();
    expect(h.frames.size).toBe(0);
    expect(h.contexts).toHaveLength(3);
  });
});

test('a failed logo load leaves the empty view usable and no animation running', async () => {
  await withEffect(h => {
    h.click(); h.images[0]!.onerror?.(); h.step(3000);
    expect(h.frames.size).toBe(0);
    expect(h.contexts[0]!.draws).toHaveLength(0);
  });
});
