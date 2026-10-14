import { expect, test } from 'bun:test';
import { SessionActivityBackground } from '../frontend/src/shared/ui/SessionActivityBackground';
import { createSteppedEaseInOut } from '../frontend/src/shared/ui/steppedEaseInOut';
import { withDOM } from './agent-chats-test-dom';

test('native timing holds each frame for 50ms and retains the ease-in-out curve', () => {
  for (const steps of [60, 80]) {
    const timing = createSteppedEaseInOut(steps);
    const stops = timing.slice(7, -1).split(', ').map(stop => stop.split(' ').map(parseFloat));
    expect(stops).toHaveLength(steps + 1);
    expect(stops[0]).toEqual([0, 0, Number((100 / steps).toFixed(6))]);
    expect(stops[steps]).toEqual([1, 100]);
    for (let i = 0; i < steps; i++) {
      const [value, start, end] = stops[i]!;
      expect((end! - start!) / 100 * steps * 50).toBeCloseTo(50, 3);
      if (i) {
        expect(start).toBe(stops[i - 1]![2]);
        expect(value!).toBeGreaterThan(stops[i - 1]![0]!);
      }
    }
    // Independent reference samples of cubic-bezier(.42, 0, .58, 1).
    expect(stops[steps / 4]![0]).toBeCloseTo(.129162, 5);
    expect(stops[steps / 2]![0]).toBeCloseTo(.5, 5);
    expect(stops[steps * 3 / 4]![0]).toBeCloseTo(.870838, 5);
  }
  for (const invalid of [0, -1, 1.5, Infinity, NaN]) {
    expect(() => createSteppedEaseInOut(invalid)).toThrow(RangeError);
  }
});

test('activity pauses outside the viewport, in hidden tabs/documents, and releases observers when completed', async () => {
  await withDOM(async ui => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const intersections: Intersection[] = [];
    const mutations: Mutation[] = [];
    class Intersection {
      target: Element | null = null;
      constructor(readonly callback: IntersectionObserverCallback) { intersections.push(this); }
      observe(target: Element) { this.target = target; }
      disconnect() { this.target = null; }
      emit(visible: boolean, target = this.target) {
        if (!target) return;
        const rect = target.getBoundingClientRect();
        this.callback([{ target, time: 0, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
          boundingClientRect: rect, intersectionRect: rect, rootBounds: null }], this as unknown as IntersectionObserver);
      }
    }
    class Mutation {
      targets = new Set<Node>();
      constructor(readonly callback: () => void) { mutations.push(this); }
      observe(target: Node) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Intersection });
    Object.defineProperty(window, 'MutationObserver', { configurable: true, value: Mutation });
    const render = (active: boolean) => ui.render(<section><SessionActivityBackground active={active} /></section>);
    await render(false);
    const panel = document.querySelector('section')!;
    const layer = panel.firstElementChild!;
    const animating = () => layer.hasAttribute('data-animating');
    expect(intersections).toHaveLength(0);
    await render(true);
    expect(panel.firstElementChild).toBe(layer);
    expect(animating()).toBe(false);
    const observer = intersections[0]!;
    observer.emit(true);
    expect(animating()).toBe(true);
    observer.emit(false);
    expect(animating()).toBe(false);
    observer.emit(true);
    for (const [attribute, value] of [['inert', ''], ['hidden', ''], ['aria-hidden', 'true']] as const) {
      panel.setAttribute(attribute, value);
      mutations[0]!.callback();
      expect(animating()).toBe(false);
      observer.emit(true);
      expect(animating()).toBe(false);
      panel.removeAttribute(attribute);
      mutations[0]!.callback();
      expect(animating()).toBe(true);
    }
    hidden = true;
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(animating()).toBe(false);
    observer.emit(true);
    expect(animating()).toBe(false);
    hidden = false;
    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(animating()).toBe(true);
    await render(false);
    expect(animating()).toBe(false);
    expect(layer.hasAttribute('data-active')).toBe(false);
    expect(panel.firstElementChild).toBe(layer);
    expect(observer.target).toBeNull();
    expect(mutations[0]!.targets.size).toBe(0);
    observer.emit(true, layer);
    mutations[0]!.callback();
    expect(animating()).toBe(false);
    await render(true);
    expect(intersections).toHaveLength(2);
    intersections[1]!.emit(true);
    expect(animating()).toBe(true);
    await ui.render(null);
    expect(intersections[1]!.target).toBeNull();
    expect(mutations[1]!.targets.size).toBe(0);
    expect(animating()).toBe(false);
  });
});
