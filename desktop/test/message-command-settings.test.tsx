import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { IMessageCommandApi, IMessageCommandSettings } from '../shared/imessage-commands';
import { product } from '../../config/product.mts';

test('message command switch requires a target, applies explicitly, and allows disabling after recipient removal', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const requests: { enabled: boolean; targetId: string | null }[] = [];
  let state: IMessageCommandSettings = { enabled: false, targetId: 'target', targets: [{ id: 'target', label: 'Test chat' }], status: 'Off' };
  const api: IMessageCommandApi = {
    get: async () => state,
    configure: async request => { requests.push(request); state = { ...state, ...request, status: request.enabled ? 'Listening' : 'Off' }; return state; },
  };
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { MessageCommandSettings } = await import('../frontend/src/features/settings/MessageCommandSettings');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<MessageCommandSettings api={api} available />));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(requests).toEqual([]); expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('Test chat');
    await act(async () => toggle.click());
    expect(requests).toEqual([{ enabled: true, targetId: 'target' }]); expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => root.render(<MessageCommandSettings api={api} available={false} />));
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    expect(requests.at(-1)).toEqual({ enabled: false, targetId: 'target' }); expect(toggle.disabled).toBe(true);
  } finally {
    await unmount?.(); await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
