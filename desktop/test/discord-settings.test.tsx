import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { DiscordApi, DiscordSettings as Snapshot } from '../shared/discord';
import { product } from '../../config/product.mts';

test('Discord test updates preserve form nodes and setup starts in the chosen chat context', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true, __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let state: Snapshot = { enabled: true, notificationsEnabled: true, guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio',
    hasToken: true, status: 'Connected', connected: true, channels: 1, pending: 0 };
  const contexts: Array<string | undefined> = [], started: string[] = [];
  let tests = 0, saves = 0, rejectToggle = false;
  const api: DiscordApi = { get: async () => state, save: async value => { saves++; state = { ...state, ...value }; return state; }, test: async () => { tests++; return state; },
    setNotificationsEnabled: async enabled => { if (rejectToggle) throw new Error('Save failed'); state = { ...state, notificationsEnabled: enabled }; return state; },
    getConfirmation: async () => null, onConfirmation: () => () => {}, respondConfirmation: async () => {},
    setup: async context => { contexts.push(context); return 'setup-thread'; } };
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { DiscordSettings } = await import('../frontend/src/features/settings/DiscordSettings');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<DiscordSettings api={api} contextId="pane" onStarted={id => { started.push(id); }} />));
    const input = container.querySelector('input[type="password"]')!;
    expect((input as HTMLInputElement).value).toBe('');
    const testButton = container.querySelector<HTMLButtonElement>('[aria-label="Send test Discord notification"]')!;
    await act(async () => testButton.click());
    expect(tests).toBe(1); expect(container.querySelector('input[type="password"]')).toBe(input);
    expect(container.textContent).toContain('Confirm receipt');
    const notificationToggle = container.querySelector<HTMLButtonElement>('[aria-label="Enable Discord notifications"]')!;
    const setup = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Setup assistant')!;
    const save = container.querySelector<HTMLButtonElement>('[aria-label="Save Discord settings"]')!;
    const connectionToggle = container.querySelector<HTMLButtonElement>('[aria-label="Enable Discord connection"]')!;
    expect(container.querySelector('button')).toBe(notificationToggle);
    await act(async () => connectionToggle.click());
    expect(connectionToggle.getAttribute('aria-checked')).toBe('false');
    rejectToggle = true;
    await act(async () => notificationToggle.click());
    expect(state.notificationsEnabled).toBe(true); expect(setup.disabled).toBe(false);
    expect(container.textContent).toContain('Save failed');
    rejectToggle = false;
    await act(async () => notificationToggle.click());
    expect(state.notificationsEnabled).toBe(false); expect(state.enabled).toBe(true); expect(state.connected).toBe(true);
    expect(saves).toBe(0);
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) {
      expect(control.disabled).toBe(control !== notificationToggle);
    }
    await act(async () => {
      testButton.click(); save.click(); setup.click(); connectionToggle.click();
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(tests).toBe(1); expect(saves).toBe(0); expect(contexts).toHaveLength(0);
    await act(async () => notificationToggle.click());
    expect(state.notificationsEnabled).toBe(true); expect(connectionToggle.getAttribute('aria-checked')).toBe('false');
    for (const control of container.querySelectorAll<HTMLInputElement>('input')) expect(control.disabled).toBe(false);
    expect((container.querySelectorAll('input')[1] as HTMLInputElement).value).toBe(state.guildId);
    await act(async () => save.click()); expect(saves).toBe(1);
    await act(async () => testButton.click()); expect(tests).toBe(2);
    await act(async () => setup.click()); expect(contexts).toEqual(['pane']); expect(started).toEqual(['setup-thread']);
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
