import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { SettingsApi, TypeSafeSettings } from '../shared/settings';
import { autopilotMenuStorageKey, createAutopilotMenuStore, useAutopilotMenu } from '../frontend/src/features/settings/useAutopilotMenu';

function MenuVisibilityObserver({ api }: { api: SettingsApi }) {
  const [visible] = useAutopilotMenu(api);
  return <output data-menu-visible={String(visible)} />;
}

const none: TypeSafeSettings = { source: 'none', maskedKey: null, canSave: true, error: null };
const saved: TypeSafeSettings = { source: 'saved', maskedKey: '••••2345', canSave: true, error: null };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function withSettings(run: (view: {
  container: HTMLElement; window: Window; savedKeys: string[]; checks: () => number;
  emit(state: TypeSafeSettings): Promise<void>; initial: ReturnType<typeof createDeferred<TypeSafeSettings>>;
}) => Promise<void>, savedMenuPreference?: string) {
  const window = new Window();
  if (savedMenuPreference !== undefined) window.localStorage.setItem(autopilotMenuStorageKey, savedMenuPreference);
  const globals = { window, document: window.document, navigator: window.navigator, Event: window.Event,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let unmount: (() => Promise<void>) | undefined;
  const listeners = new Set<(state: TypeSafeSettings) => void>();
  const publish = (state: TypeSafeSettings) => { for (const listener of listeners) listener(state); };
  const initial = createDeferred<TypeSafeSettings>();
  const savedKeys: string[] = [];
  let checks = 0;
  const api: SettingsApi = {
    getTypeSafe: async () => initial.promise,
    saveTypeSafe: async key => { savedKeys.push(key); publish(saved); return saved; },
    removeTypeSafe: async () => { publish(none); return none; },
    checkTypeSafe: async () => { checks++; return true; },
    onTypeSafeChanged(handler) { listeners.add(handler); return () => { listeners.delete(handler); }; },
  };
  try {
    const { createRoot } = await import('react-dom/client');
    const { SettingsView } = await import('../frontend/src/features/settings/SettingsView');
    const container = globalThis.document.createElement('div');
    globalThis.document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<>
      <SettingsView api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />
      <MenuVisibilityObserver api={api} />
    </>));
    await run({ container, window, savedKeys, checks: () => checks, initial,
      emit: async state => { await act(async () => publish(state)); } });
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function button(container: HTMLElement, label: string) {
  const control = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label);
  if (!control) throw new Error(`Missing button ${label}`);
  return control;
}

test('settings saves a password, clears it, verifies the connection and deletes the saved key', async () => {
  await withSettings(async ({ container, window, initial, savedKeys, checks }) => {
    await act(async () => initial.resolve(none));
    expect(container.querySelector('aside')?.textContent).toContain('TypeSafe API');
    const input = container.querySelector('input')!;
    expect(input.type).toBe('password');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'fixture-key-12345');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(container, 'Save key').disabled).toBe(false);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(savedKeys).toEqual(['fixture-key-12345']);
    expect(input.value).toBe('');
    expect(container.textContent).toContain('••••2345');
    expect(container.textContent).not.toContain('fixture-key-12345');
    const toggle = button(container, 'Show Autopilot menu');
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => button(container, 'Check connection').click());
    expect(checks()).toBe(1);
    expect(container.textContent).toContain('Connection verified.');
    await act(async () => button(container, 'Delete saved key').click());
    expect(container.textContent).toContain('No API key registered');
    expect(button(container, 'Check connection').disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('output')?.getAttribute('data-menu-visible')).toBe('false');
    expect(window.localStorage.getItem(autopilotMenuStorageKey)).toBe('false');
  });
});

test('a stale initial load cannot replace updated settings and unavailable storage disables saving', async () => {
  await withSettings(async ({ container, initial, emit }) => {
    await emit(saved);
    await act(async () => initial.resolve(none));
    expect(container.textContent).toContain('Saved on this computer');
    expect(button(container, 'Show Autopilot menu').disabled).toBe(false);
    await emit({ ...saved, canSave: false, maskedKey: null, error: 'Unlock the saved key.' });
    expect(container.querySelector('input')!.disabled).toBe(true);
    expect(button(container, 'Update key').disabled).toBe(true);
    expect(container.textContent).toContain('Unlock the saved key.');
    expect(button(container, 'Show Autopilot menu').disabled).toBe(true);
  });
});

test('Autopilot toggle updates subscribers, persists selection and responds to another window', async () => {
  await withSettings(async ({ container, window, savedKeys, checks, initial }) => {
    await act(async () => initial.resolve(saved));
    const toggle = button(container, 'Show Autopilot menu');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('output')?.getAttribute('data-menu-visible')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('output')?.getAttribute('data-menu-visible')).toBe('true');
    expect(window.localStorage.getItem(autopilotMenuStorageKey)).toBe('true');
    await act(async () => {
      window.localStorage.setItem(autopilotMenuStorageKey, 'false');
      window.dispatchEvent(new window.StorageEvent('storage', { key: autopilotMenuStorageKey, newValue: 'false' }));
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('output')?.getAttribute('data-menu-visible')).toBe('false');
    expect(savedKeys).toEqual([]);
    expect(checks()).toBe(0);
  });
});

test('Autopilot menu preference restores across sessions and accepts only a saved true value', () => {
  let saved: string | null = null;
  const storage = { read: () => saved, write: (visible: boolean) => { saved = String(visible); } };
  const store = createAutopilotMenuStore(storage);
  expect(store.getSnapshot()).toBe(false);
  store.setVisible(false);
  expect(createAutopilotMenuStore(storage).getSnapshot()).toBe(false);
  store.setVisible(true);
  expect(createAutopilotMenuStore(storage).getSnapshot()).toBe(true);
  for (const invalid of ['', '1', 'TRUE', 'invalid']) {
    saved = invalid;
    expect(createAutopilotMenuStore(storage).getSnapshot()).toBe(false);
  }
});

test('Autopilot menu toggle remains usable when storage is unavailable', () => {
  const store = createAutopilotMenuStore({
    read: () => { throw new Error('Storage unavailable'); },
    write: () => { throw new Error('Storage unavailable'); },
  });
  expect(store.getSnapshot()).toBe(false);
  store.setVisible(true);
  store.refresh();
  expect(store.getSnapshot()).toBe(true);
});

test('missing or loading API keys disable the toggle and hide a previously enabled menu', async () => {
  await withSettings(async ({ container, initial, window }) => {
    const toggle = button(container, 'Show Autopilot menu');
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('output')?.getAttribute('data-menu-visible')).toBe('false');
    await act(async () => initial.resolve(none));
    await act(async () => toggle.click());
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(window.localStorage.getItem(autopilotMenuStorageKey)).toBe('false');
  }, 'true');
});

test('an environment key enables the toggle and preserves an explicit saved ON preference', async () => {
  await withSettings(async ({ container, initial, emit }) => {
    const toggle = button(container, 'Show Autopilot menu');
    expect(toggle.disabled).toBe(true);
    await act(async () => initial.resolve({ ...saved, source: 'environment', canSave: false }));
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('output')?.getAttribute('data-menu-visible')).toBe('true');
    await emit(none);
    expect(toggle.disabled).toBe(true);
    await emit(saved);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  }, 'true');
});
