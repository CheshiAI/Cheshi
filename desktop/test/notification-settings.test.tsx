import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { DEFAULT_IMESSAGE_PREFERENCES, type IMessageApi, type IMessageSettings } from '../shared/imessage-notifications';
import { product } from '../../config/product.mts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test.each(['success', 'failure'] as const)('test %s keeps settings editable, retains edits and reuses its status region', async outcome => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Event: window.Event,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
    __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let state: IMessageSettings = { ...DEFAULT_IMESSAGE_PREFERENCES, recipient: 'me@example.com', available: true, lastStatus: null };
  let listener: ((value: IMessageSettings) => void) | undefined;
  let sends = 0, saves = 0;
  const testResult = createDeferred<IMessageSettings>();
  const api: IMessageApi = {
    get: async () => state,
    save: async value => { saves++; state = { ...state, ...value }; listener?.(state); return state; },
    test: async () => { sends++; return testResult.promise; },
    onChanged: callback => { listener = callback; return () => { listener = undefined; }; }, reportQueue: async () => {},
  };
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { NotificationSettings } = await import('../frontend/src/features/settings/NotificationSettings');
    const container = globalThis.document.createElement('div'); globalThis.document.body.append(container);
    const root = createRoot(container); unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<NotificationSettings api={api} />));
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Enable iMessage notifications"]')!;
    const testButton = container.querySelector<HTMLButtonElement>('[aria-label="Send test iMessage"]')!;
    const saveButton = container.querySelector<HTMLButtonElement>('[aria-label="Save notification settings"]')!;
    const recipient = container.querySelector<HTMLInputElement>('[aria-label="Recipient"]')!;
    const feedback = container.querySelector('[role="status"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false'); expect(sends).toBe(0);
    await act(async () => toggle.click());
    expect(testButton.disabled).toBe(true);
    await act(async () => listener?.({ ...state, lastStatus: 'Background status' }));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => saveButton.click());
    expect(saves).toBe(1); expect(state.enabled).toBe(true); expect(testButton.disabled).toBe(false);
    expect(sends).toBe(0);
    await act(async () => testButton.click());
    expect(sends).toBe(1); expect(saveButton.disabled).toBe(true); expect(testButton.disabled).toBe(true);
    expect(recipient.disabled).toBe(false);
    for (const control of recipient.closest('form')!.querySelectorAll<HTMLButtonElement>('[role="switch"]')) expect(control.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBe(feedback);
    expect(feedback.textContent).toBe('Sending test iMessage…');
    await act(async () => {
      testButton.click(); saveButton.click();
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      toggle.click();
      listener?.({ ...state, lastStatus: 'Submitted to Messages.' });
    });
    expect(sends).toBe(1); expect(saves).toBe(1);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      if (outcome === 'success') testResult.resolve({ ...state, lastStatus: 'Submitted to Messages.' });
      else testResult.reject(new Error('Allow Cheshi to control Messages.'));
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(saveButton.disabled).toBe(false); expect(testButton.disabled).toBe(true);
    expect(container.querySelector(outcome === 'success' ? '[role="status"]' : '[role="alert"]')).toBe(feedback);
    expect(feedback.textContent).toBe(outcome === 'success' ? 'Submitted to Messages.' : 'Allow Cheshi to control Messages.');
    await act(async () => saveButton.click());
    expect(state.enabled).toBe(false); expect(saves).toBe(2);
  } finally {
    await unmount?.(); expect(listener).toBeUndefined(); await window.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
