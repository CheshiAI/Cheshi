import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { DiscordApi, DiscordSettings as Snapshot } from '../shared/discord';
import { product } from '../../config/product.mts';

test('Discord test updates preserve form nodes and setup starts in the chosen chat context', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const state: Snapshot = { enabled: true, guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio',
    hasToken: true, status: 'Connected', connected: true, channels: 1, pending: 0 };
  const contexts: Array<string | undefined> = [], started: string[] = [];
  let tests = 0;
  const api: DiscordApi = { get: async () => state, save: async () => state, test: async () => { tests++; return state; },
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
    const setup = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Setup assistant')!;
    await act(async () => setup.click()); expect(contexts).toEqual(['pane']); expect(started).toEqual(['setup-thread']);
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
