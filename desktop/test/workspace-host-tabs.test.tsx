import { expect, test } from 'bun:test';
import { act } from 'react';
import { WorkspaceHostShell } from '../frontend/src/features/shell/WorkspaceHostShell';
import type { WorkspaceHostApi, WorkspaceHostEntry, WorkspaceHostState, WorkspaceRailEvent, WorkspaceRailOverlay } from '../shared/workspace-host';
import { withDOM } from './agent-chats-test-dom';

function entry(id: number, name: string): WorkspaceHostEntry {
  return { id, name, root: `/test/${name}`, view: 'explorer', sidebarOpen: true, running: 0, attention: false };
}

function createHost() {
  let state: WorkspaceHostState = { activeId: 1, entries: [entry(1, 'Desktop')] };
  let listener: ((state: WorkspaceHostState) => void) | undefined;
  const closed: number[] = [];
  const commands: string[] = [];
  const overlays: (WorkspaceRailOverlay | null)[] = [];
  let railListener: ((event: WorkspaceRailEvent) => void) | undefined;
  const publish = (next: WorkspaceHostState) => { state = next; listener?.(next); };
  const api: WorkspaceHostApi = {
    showStatusToast: async () => false,
    state: async () => state,
    onState: next => { listener = next; return () => { listener = undefined; }; },
    activate: async id => { publish({ ...state, activeId: id }); },
    close: async id => {
      closed.push(id);
      const entries = state.entries.filter(item => item.id !== id);
      publish({ entries, activeId: entries[0]?.id ?? null });
    },
    command: async command => { commands.push(command.action); },
    layout: async () => {},
    railOverlay: value => { overlays.push(value); },
    onRailEvent: next => { railListener = next; return () => { railListener = undefined; }; },
  };
  return { api, closed, commands, publish, overlays, railEvent: (event: WorkspaceRailEvent) => railListener?.(event) };
}

test('rail hover publishes a label and native label clicks invoke the original button', async () => {
  await withDOM(async ui => {
    const host = createHost();
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Github"]')!;
    await act(async () => { button.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })); });
    expect(button.hasAttribute('data-rail-expanded')).toBe(true);
    expect(host.overlays.at(-1)?.label).toBe('Github');
    await act(async () => host.railEvent({ id: button.dataset.railButton!, action: 'activate' }));
    expect(host.commands).toEqual(['navigate']);
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.at(-1)).toBeNull();
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab' }));
      button.blur(); button.focus();
    });
    expect(button.hasAttribute('data-rail-expanded')).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="tab"]')!.focus());
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.at(-1)).toBeNull();
  });
});

test('restoring focus after app activation does not expand the previously focused rail button', async () => {
  await withDOM(async ui => {
    const host = createHost();
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Explorer"]')!;
    await act(async () => button.focus());
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.some(value => value !== null)).toBe(false);
    await act(async () => {
      button.blur();
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab' }));
      button.focus();
    });
    expect(button.hasAttribute('data-rail-expanded')).toBe(true);
    await act(async () => {
      window.dispatchEvent(new window.Event('blur'));
      // The native BrowserWindow dismisses the label on deactivation.
      host.railEvent({ id: button.dataset.railButton!, action: 'dismiss' });
      button.blur();
      window.dispatchEvent(new window.Event('focus'));
      button.focus();
    });
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.at(-1)).toBeNull();
    expect(host.commands).toEqual([]);
    await act(async () => button.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })));
    expect(button.hasAttribute('data-rail-expanded')).toBe(true);
  });
});

test('a mouse click cancels previous keyboard intent before a rail button receives focus', async () => {
  await withDOM(async ui => {
    const host = createHost();
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Explorer"]')!;
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab' }));
      document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
      button.focus();
    });
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    expect(host.overlays.some(value => value !== null)).toBe(false);
  });
});

test('adding and closing workspaces toggles close controls while preserving the remaining tab', async () => {
  await withDOM(async ui => {
    const host = createHost();
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const tablist = document.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute('data-single')).toBe('true');
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(tablist.querySelector('[aria-label^="Close workspace"]')).toBeNull();
    await ui.click('Open workspace');
    expect(host.commands).toEqual(['manager']);
    const originalTab = tablist.querySelector('[role="tab"]');
    await act(async () => host.publish({ activeId: 2, entries: [entry(1, 'Desktop'), entry(2, 'Flash')] }));
    expect(tablist.getAttribute('data-single')).toBe('false');
    expect(tablist.querySelectorAll('[aria-label^="Close workspace"]')).toHaveLength(2);
    expect(tablist.querySelector('[role="tab"]')).toBe(originalTab);
    await ui.click('Close workspace Flash');
    expect(host.closed).toEqual([2]);
    expect(tablist.getAttribute('data-single')).toBe('true');
    expect(tablist.querySelector('[aria-label^="Close workspace"]')).toBeNull();
    expect(tablist.querySelector('[role="tab"]')).toBe(originalTab);
    expect(originalTab?.getAttribute('aria-selected')).toBe('true');
  });
});

test('multiple tabs retain click and arrow-key selection and keyboard focus', async () => {
  await withDOM(async ui => {
    const host = createHost();
    host.publish({ activeId: 1, entries: [entry(1, 'Desktop'), entry(2, 'Flash'), entry(3, 'Show')] });
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const flash = document.querySelector<HTMLButtonElement>('[role="tab"][data-workspace-id="2"]')!;
    await act(async () => flash.click());
    const selected = () => document.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected()?.getAttribute('data-workspace-id')).toBe('2');
    await act(async () => {
      selected()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(selected()?.getAttribute('data-workspace-id')).toBe('3');
    expect(document.activeElement).toBe(selected());
    expect(document.querySelectorAll('[aria-label^="Close workspace"]')).toHaveLength(3);
  });
});

test('active workspace modals block chrome and clear rail overlays until dismissal', async () => {
  await withDOM(async ui => {
    const host = createHost();
    const entries = [entry(1, 'Desktop'), entry(2, 'Flash')];
    host.publish({ activeId: 1, entries });
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const rail = document.querySelector<HTMLElement>('[aria-label="Application navigation"]')!;
    const button = rail.querySelector<HTMLButtonElement>('[data-rail-button]')!;
    const tabs = document.querySelector<HTMLElement>('[role="tablist"]')!;
    await act(async () => button.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })));
    expect(host.overlays.at(-1)).not.toBeNull();
    await act(async () => host.publish({ activeId: 1, entries: [{ ...entries[0]!, modalOpen: true }, entries[1]!] }));
    expect(rail.hasAttribute('inert')).toBe(true);
    expect(tabs.parentElement!.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-modal-open="true"]')).not.toBeNull();
    expect(host.overlays.at(-1)).toBeNull();
    expect(button.hasAttribute('data-rail-expanded')).toBe(false);
    await act(async () => tabs.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-workspace-id')).toBe('1');
    // A modal in a retained background workspace must not block the visible one.
    await act(async () => host.publish({ activeId: 1, entries: [entries[0]!, { ...entries[1]!, modalOpen: true }] }));
    expect(rail.hasAttribute('inert')).toBe(false);
    expect(tabs.parentElement!.hasAttribute('inert')).toBe(false);
    await ui.click('Open workspace');
    expect(host.commands).toEqual(['manager']);
  });
});

test('running dots share the bounded clock and release it when hidden or replaced by status updates', async () => {
  await withDOM(async ui => {
    let hidden = false, nextTimer = 0, pauses = 0;
    const timers = new Set<number>();
    const observers: Observer[] = [];
    class Observer {
      element: Element | null = null;
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; observers.push(this); }
      observe(element: Element) { this.element = element; }
      disconnect() { this.element = null; }
      emit(visible: boolean) {
        const target = this.element;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        this.callback([{ target, time: 0, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
          boundingClientRect: rect, intersectionRect: rect, rootBounds: null }], this as unknown as IntersectionObserver);
      }
    }
    Object.defineProperties(window, {
      IntersectionObserver: { configurable: true, value: Observer },
      setTimeout: { configurable: true, value: () => { const id = ++nextTimer; timers.add(id); return id; } },
      clearTimeout: { configurable: true, value: (id: number) => timers.delete(id) },
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(window.HTMLElement.prototype, 'getAnimations', { configurable: true, value(this: HTMLElement) {
      return [{ currentTime: 0, effect: { target: this }, pause() { pauses++; } }];
    } });
    const host = createHost();
    const first = { ...entry(1, 'Desktop'), running: 1 };
    const second = { ...entry(2, 'Flash'), running: 2 };
    host.publish({ activeId: 1, entries: [first, second] });
    await ui.render(<WorkspaceHostShell api={host.api} />);
    const dot = document.querySelector('[aria-label="1 running"]')!;
    expect(dot.hasAttribute('data-animation-paused')).toBe(true);
    expect(timers.size).toBe(0);
    expect(observers).toHaveLength(2);
    await act(async () => observers.forEach(observer => observer.emit(true)));
    expect(timers.size).toBe(1);
    expect(pauses).toBe(2);
    expect(dot.hasAttribute('data-animation-paused')).toBe(false);
    await act(async () => host.publish({ activeId: 1, entries: [{ ...first, running: 3 }, second] }));
    expect(document.querySelector('[aria-label="3 running"]')).toBe(dot);
    expect(pauses).toBe(2); // Updating the task count must not restart the animation.
    await act(async () => observers[0]!.emit(false));
    expect(timers.size).toBe(1);
    await act(async () => observers[1]!.emit(false));
    expect(timers.size).toBe(0);
    await act(async () => observers[0]!.emit(true));
    expect(timers.size).toBe(1);
    hidden = true;
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    expect(timers.size).toBe(0);
    hidden = false;
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    expect(timers.size).toBe(1);
    await act(async () => host.publish({ activeId: 1, entries: [
      { ...first, attention: true }, { ...second, running: 0 },
    ] }));
    expect(document.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
    expect(document.querySelector('[data-loading-animation]')).toBeNull();
    expect(timers.size).toBe(0);
    expect(observers.every(observer => observer.element === null)).toBe(true);
  });
});
