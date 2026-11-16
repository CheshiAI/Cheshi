import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { DEFAULT_WINDOW_APPEARANCE } from '../shared/window-appearance';
import type { WindowAppearanceApi, WindowAppearanceState } from '../shared/window-appearance';
import { applyWindowAppearance } from '../frontend/src/features/settings/windowAppearance';

test('renderer opens only active native glass and keeps main panes opaque when requested', () => {
  const document = new Window().document;
  const root = document.documentElement as unknown as HTMLElement;
  const state: WindowAppearanceState = { preferences: { ...DEFAULT_WINDOW_APPEARANCE }, supported: true, active: true, error: null };
  applyWindowAppearance(state, root);
  expect(root.hasAttribute('data-window-glass')).toBe(true);
  expect(root.hasAttribute('data-main-pane-glass')).toBe(true);
  applyWindowAppearance({ ...state, preferences: { ...state.preferences, mainPaneGlass: false } }, root);
  expect(root.hasAttribute('data-main-pane-glass')).toBe(false);
  applyWindowAppearance({ ...state, active: false }, root);
  expect(root.hasAttribute('data-window-glass')).toBe(false);
});

test('appearance toggle and reset immediately persist and restore all default controls', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Event: window.Event,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const state: WindowAppearanceState = {
    preferences: { enabled: true, mainPaneGlass: false, opacity: .4, blurRadius: 48 },
    supported: true, active: true, error: null,
  };
  const saves: unknown[] = [];
  const api: WindowAppearanceApi = {
    get: async () => state,
    set: async preferences => { saves.push(preferences); return { ...state, preferences }; },
    onChanged: () => () => {},
  };
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { AppearanceSettings } = await import('../frontend/src/features/settings/AppearanceSettings');
    const container = globalThis.document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<AppearanceSettings api={api} />));
    const enabled = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(enabled.getAttribute('aria-checked')).toBe('true');
    await act(async () => enabled.click());
    expect(enabled.getAttribute('aria-checked')).toBe('false');
    expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Apply')).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[aria-labelledby="main-pane-transparency-label"]')!.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="range"]')].every(input => input.disabled)).toBe(true);
    expect(saves).toEqual([{ ...state.preferences, enabled: false }]);
    const reset = [...container.querySelectorAll('button')].find(button => button.textContent === 'Reset to default')!;
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    expect(enabled.getAttribute('aria-checked')).toBe('true');
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="range"]')].every(input => !input.disabled)).toBe(true);
    expect(saves[1]).toEqual({ enabled: true, mainPaneGlass: true, opacity: .75, blurRadius: 16 });
    expect(container.querySelector('[aria-labelledby="main-pane-transparency-label"]')!.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Window Opacity"]')!.value).toBe('75');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Window Blur Radius"]')!.value).toBe('16');
  } finally {
    await unmount?.();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
