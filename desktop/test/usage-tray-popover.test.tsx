import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { UsageTrayPopover } from '../frontend/src/features/account/UsageTrayPopover';
import type { UsagePopoverApi, UsagePopoverState } from '../shared/account-usage-popover';
import { DEFAULT_WINDOW_APPEARANCE } from '../shared/window-appearance';

function state(revision: number, remaining = 91): UsagePopoverState {
  return { revision, dark: true,
    appearance: { preferences: { ...DEFAULT_WINDOW_APPEARANCE }, supported: true, active: true, error: null },
    snapshot: { activeId: 'b', profiles: [0, remaining].map((value, index) => ({
    id: index ? 'b' : 'a', email: `${index}@example.com`, label: `Account ${index}`,
    login: { state: 'signed_in', error: null }, usage: { state: 'ready', authenticated: true, plan: 'pro', error: null,
      rateLimits: [{ limitId: 'codex', limitName: null, plan: 'pro', primary: null,
        secondary: { usedPercent: 100 - value, windowDurationMins: 10080, resetsAt: 1790000000 } }] },
  })) } };
}

test('shares account details, updates usage and theme, ignores stale reads and exposes only show and quit actions', async () => {
  const window = new Window();
  let measure: (() => void) | undefined;
  let disconnected = false;
  class ResizeObserver {
    constructor(callback: () => void) { measure = callback; }
    observe() {} disconnect() { disconnected = true; }
  }
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const globals = { window, document: window.document, navigator: window.navigator, ResizeObserver,
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  const container = window.document.createElement('div'); window.document.body.append(container);
  const summaryLines = () => [...container.querySelectorAll('p > span')].map(row => row.textContent);
  const root = createRoot(container as unknown as HTMLElement);
  let contentHeight = 320.25;
  let viewportHeight = 640;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = this.tagName === 'MAIN' || this.parentElement === container ? viewportHeight : contentHeight;
    return new window.DOMRect(0, 0, 240, height);
  };
  const paint = async () => { await act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  }); };
  let receive: (value: UsagePopoverState) => void = () => {};
  let resolve!: (value: UsagePopoverState) => void;
  const pending = new Promise<UsagePopoverState>(done => { resolve = done; });
  const actions: string[] = [];
  const sizes: number[] = [];
  const ready: (number | null)[] = [];
  let resizeDone: (() => void) | undefined;
  let holdResize = true;
  let unsubscribed = false;
  const api: UsagePopoverApi = { read: () => pending,
    onChange(listener) { receive = listener; return () => { unsubscribed = true; }; },
    async resize(height) {
      sizes.push(height);
      if (holdResize) await new Promise<void>(resolve => { resizeDone = resolve; });
    },
    async ready(revision) { ready.push(revision); },
    async action(action) { actions.push(action); } };
  try {
    await act(async () => root.render(<UsageTrayPopover api={api} />));
    expect(window.document.documentElement.hasAttribute('data-window-glass')).toBe(false);
    expect(container.textContent).toContain('Loading accounts…');
    expect(sizes.at(-1)).toBe(321);
    expect(ready).toEqual([]);
    await act(async () => { holdResize = false; resizeDone?.(); });
    holdResize = true;
    await act(async () => receive(state(2)));
    await paint(); await paint();
    expect(ready).toEqual([]);
    await act(async () => { holdResize = false; resizeDone?.(); });
    await paint();
    expect(ready).toEqual([]);
    await paint();
    expect(ready).toEqual([2]);
    await act(async () => resolve(state(1, 10)));
    expect(container.textContent).toContain('91% remaining');
    expect(summaryLines())
      .toEqual(['91% remaining', '200% total capacity', '2 accounts']);
    expect(container.textContent).toContain('0% remaining');
    expect(container.textContent).toContain('Pro plan');
    expect(container.textContent).toContain('Resets');
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Use account"]')).toBeNull();
    expect(window.document.documentElement.hasAttribute('data-window-glass')).toBe(true);
    expect(window.document.documentElement.style.getPropertyValue('--window-glass-opacity')).toBe('0.75');
    const next = state(3, 80); next.dark = false; next.appearance!.active = false;
    next.scheduler = { running: 2, pending: 1, next: null };
    await act(async () => receive(next));
    await paint();
    await act(async () => receive({ ...next, revision: 4 }));
    await paint(); await paint();
    expect(ready).toEqual([2, 4]);
    expect(container.textContent).toContain('80% remaining');
    expect(summaryLines())
      .toEqual(['80% remaining', '200% total capacity', '2 accounts']);
    expect(window.document.documentElement.dataset.theme).toBe('light');
    expect(window.document.documentElement.hasAttribute('data-window-glass')).toBe(false);
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Show Cheshi', 'Quit Cheshi']);
    expect(container.textContent).not.toContain('Tasks');
    await act(async () => { for (const button of container.querySelectorAll('button')) button.click(); });
    expect(actions).toEqual(['show', 'quit']);
    // A shorter update must shrink the window even while the surface fills the old viewport.
    viewportHeight = 321;
    contentHeight = 200.25;
    await act(async () => measure?.());
    expect(sizes.at(-1)).toBe(201);
    const added = state(5, 80);
    added.appearance!.preferences.opacity = 0.6;
    added.snapshot!.profiles.push({ ...added.snapshot!.profiles[1]!, id: 'c', email: 'c@example.com' });
    await act(async () => receive(added));
    expect(summaryLines())
      .toEqual(['160% remaining', '300% total capacity', '3 accounts']);
    expect(window.document.documentElement.style.getPropertyValue('--window-glass-opacity')).toBe('0.6');
    await act(async () => receive(state(3)));
    expect(window.document.documentElement.style.getPropertyValue('--window-glass-opacity')).toBe('0.6');
    const unavailable = state(6);
    unavailable.appearance!.active = false;
    unavailable.appearance!.error = 'Could not apply native window transparency.';
    unavailable.snapshot!.profiles[1]!.usage.rateLimits = [];
    await act(async () => receive(unavailable));
    expect(container.textContent).toContain('Usage unavailable');
    expect(container.textContent).not.toContain('total capacity');
    expect(window.document.documentElement.hasAttribute('data-window-glass')).toBe(false);
    await act(async () => receive({ revision: 7, dark: true, snapshot: null, appearance: null }));
    expect(container.textContent).toContain('Usage unavailable');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
    const failedReadApi: UsagePopoverApi = { ...api, read: async () => { throw new Error('Account data unavailable'); } };
    await act(async () => root.render(<UsageTrayPopover api={failedReadApi} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Account data unavailable');
    await paint(); await paint();
    expect(ready.at(-1)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    expect(disconnected).toBe(true); expect(unsubscribed).toBe(true);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
