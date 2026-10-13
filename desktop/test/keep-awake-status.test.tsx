import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { KeepAwakeApi, KeepAwakeState } from '../shared/keep-awake';
import { KeepAwakeStatus } from '../frontend/src/features/chrome/KeepAwakeStatus';
import { registryDeferred } from './agent-registry-fixtures';

const off: KeepAwakeState = { supported: true, enabled: false, busy: false, error: null, revision: 0 };

async function withStatus(run: (ui: {
  initial: ReturnType<typeof registryDeferred<KeepAwakeState>>;
  publish(state: KeepAwakeState): Promise<void>;
  render(platform?: string): Promise<void>;
  status(): HTMLElement | null;
  subscribed(): boolean;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Node: window.Node, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const initial = registryDeferred<KeepAwakeState>();
  let listener: ((state: KeepAwakeState) => void) | undefined;
  const api: KeepAwakeApi & { platform: string } = {
    platform: 'darwin', getKeepAwake: () => initial.promise,
    setKeepAwake: async () => { throw new Error('Status display must not change caffeine mode.'); },
    onKeepAwakeChanged: next => { listener = next; return () => { listener = undefined; }; },
  };
  try {
    await run({ initial,
      publish: async state => { await act(async () => listener?.(state)); },
      render: async (platform = 'darwin') => { await act(async () => root.render(<KeepAwakeStatus api={platform === 'darwin' ? api : { ...api, platform }} />)); },
      status: () => document.querySelector<HTMLElement>('[role="status"]'), subscribed: () => !!listener,
    });
  } finally {
    await act(async () => root.unmount());
    expect(listener).toBeUndefined();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('caffeine status follows confirmed updates with English tooltips and ignores a stale initial response', async () => {
  await withStatus(async ui => {
    await ui.render();
    expect(ui.status()?.textContent).toBe('…');
    expect(ui.status()?.getAttribute('aria-description')).toBe('Checking caffeine mode…');
    await ui.publish({ ...off, enabled: true, revision: 2 });
    expect(ui.status()?.textContent).toBe('ON');
    expect(ui.status()?.getAttribute('data-enabled')).toBe('true');
    expect(ui.status()?.getAttribute('aria-description')).toBe('Caffeine mode on · Your Mac will stay awake.');
    await act(async () => ui.initial.resolve(off));
    expect(ui.status()?.textContent).toBe('ON');
    await ui.publish({ ...off, enabled: true, busy: true, revision: 3 });
    expect(ui.status()?.textContent).toBe('…');
    expect(ui.status()?.getAttribute('aria-description')).toBe('Updating caffeine mode…');
    await ui.publish({ ...off, revision: 4 });
    expect(ui.status()?.textContent).toBe('OFF');
    expect(ui.status()?.getAttribute('data-enabled')).toBeNull();
    expect(ui.status()?.getAttribute('aria-description')).toBe('Caffeine mode off · Your Mac can sleep normally.');
    await ui.publish({ ...off, enabled: true, revision: 1 });
    expect(ui.status()?.textContent).toBe('OFF');
  });
});

test('unavailable and unsupported states never appear as OFF and subscriptions are released', async () => {
  await withStatus(async ui => {
    await ui.render();
    await act(async () => ui.initial.reject(new Error('Unavailable')));
    expect(ui.status()?.textContent).toBe('?');
    expect(ui.status()?.getAttribute('aria-description')).toBe('Caffeine mode status unavailable.');
    await ui.publish({ ...off, enabled: true, revision: 1 });
    expect(ui.status()?.textContent).toBe('ON');
    await ui.publish({ ...off, enabled: true, error: 'Cannot confirm the process', revision: 2 });
    expect(ui.status()?.textContent).toBe('?');
    await ui.publish({ ...off, supported: false, revision: 3 });
    expect(ui.status()).toBeNull();
    await ui.render('linux');
    expect(ui.status()).toBeNull();
    expect(ui.subscribed()).toBe(false);
  });
});
