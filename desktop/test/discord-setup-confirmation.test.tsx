import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { product } from '../../config/product.mts';
import type { DiscordApi, DiscordConfirmation } from '../shared/discord';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

test('shared Discord modal handles event races, cancellation, retries and duplicate submissions', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const initial = createDeferred<DiscordConfirmation | null>();
  let response = createDeferred<void>();
  let listener: ((value: DiscordConfirmation | null) => void) | undefined;
  let unsubscribed = false;
  const answers: Array<{ id: string; accepted: boolean }> = [];
  const api: Pick<DiscordApi, 'getConfirmation' | 'onConfirmation' | 'respondConfirmation'> = {
    getConfirmation: () => initial.promise,
    onConfirmation: callback => { listener = callback; return () => { unsubscribed = true; }; },
    respondConfirmation: (id, accepted) => { answers.push({ id, accepted }); return response.promise; },
  };
  const request: DiscordConfirmation = { id: 'first', guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio' };
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { DiscordSetupConfirmation } = await import('../frontend/src/features/settings/DiscordSetupConfirmation');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<DiscordSetupConfirmation api={api} />));
    await act(async () => { listener!(request); initial.resolve(null); });
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('CONNECT DISCORD');
    expect([...document.querySelectorAll('dd')].map(element => element.textContent)).toEqual([request.guildId, request.ownerId, 'Studio']);
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!;
    await act(async () => {
      button('Use this server').click();
      button('Use this server').click();
    });
    expect(answers).toEqual([{ id: 'first', accepted: true }]);
    expect(button('Cancel').disabled).toBe(true);
    await act(async () => response.reject(new Error('Please retry.')));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Please retry.');
    expect(button('Cancel').disabled).toBe(false);
    response = createDeferred<void>();
    await act(async () => button('Cancel').click());
    expect(answers.at(-1)).toEqual({ id: 'first', accepted: false });
    await act(async () => { listener!(null); response.resolve(); });
    expect(document.querySelector('dialog')).toBeNull();

    for (const action of ['close', 'escape']) {
      response = createDeferred<void>();
      await act(async () => listener!({ ...request, id: action }));
      await act(async () => {
        if (action === 'close') document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
        else document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true }) as unknown as Event);
      });
      expect(answers.at(-1)).toEqual({ id: action, accepted: false });
      await act(async () => { listener!(null); response.resolve(); });
      expect(document.querySelector('dialog')).toBeNull();
    }
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
  expect(unsubscribed).toBe(true);
});
