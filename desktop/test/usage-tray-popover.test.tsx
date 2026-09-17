import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { UsageTrayPopover } from '../frontend/src/features/account/UsageTrayPopover';
import type { UsagePopoverApi, UsagePopoverState } from '../shared/account-usage-popover';

function state(revision: number, remaining = 91): UsagePopoverState {
  return { revision, dark: true, snapshot: { activeId: 'b', profiles: [0, remaining].map((value, index) => ({
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
  const globals = { window, document: window.document, navigator: window.navigator, ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  const container = window.document.createElement('div'); window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  let receive: (value: UsagePopoverState) => void = () => {};
  let resolve!: (value: UsagePopoverState) => void;
  const pending = new Promise<UsagePopoverState>(done => { resolve = done; });
  const actions: string[] = [];
  const sizes: number[] = [];
  let unsubscribed = false;
  const api: UsagePopoverApi = { read: () => pending,
    onChange(listener) { receive = listener; return () => { unsubscribed = true; }; },
    async resize(height) { sizes.push(height); }, async action(action) { actions.push(action); } };
  try {
    await act(async () => root.render(<UsageTrayPopover api={api} />));
    await act(async () => receive(state(2)));
    await act(async () => resolve(state(1, 10)));
    expect(container.textContent).toContain('91% remaining');
    expect(container.textContent).toContain('0% remaining');
    expect(container.textContent).toContain('Pro plan');
    expect(container.textContent).toContain('Resets');
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Use account"]')).toBeNull();
    const next = state(3, 80); next.dark = false;
    await act(async () => receive(next));
    expect(container.textContent).toContain('80% remaining');
    expect(window.document.documentElement.dataset.theme).toBe('light');
    await act(async () => { for (const button of container.querySelectorAll('button')) button.click(); });
    expect(actions).toEqual(['show', 'quit']);
    await act(async () => measure?.()); expect(sizes.length).toBeGreaterThan(0);
    await act(async () => receive({ revision: 4, dark: true, snapshot: null }));
    expect(container.textContent).toContain('Usage unavailable');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    expect(disconnected).toBe(true); expect(unsubscribed).toBe(true);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
