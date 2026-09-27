import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { DEFAULT_IMESSAGE_PREFERENCES, type IMessageApi, type IMessageSettings } from '../shared/imessage-notifications';
import { product } from '../../config/product.mts';
import type { NotificationEventsApi, NotificationEventSettings } from '../shared/notification-events';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test.each([
  { outcome: 'success', recipient: 'me@example.com' }, { outcome: 'failure', recipient: 'me@example.com' },
  { outcome: 'success', recipient: '' },
])('notification controls preserve setup, disabled state and feedback: %j', async ({ outcome, recipient: initialRecipient }) => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Event: window.Event,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
    __CHESHI_PRODUCT__: product };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let state: IMessageSettings = { ...DEFAULT_IMESSAGE_PREFERENCES, recipient: initialRecipient, available: true, lastStatus: null };
  let listener: ((value: IMessageSettings) => void) | undefined;
  let sends = 0, saves = 0, commands = 0, rejectSave = false;
  const commandState = { enabled: true, targetId: 'chat', targets: [{ id: 'chat', label: 'Chat' }], status: 'Ready' };
  const testResult = createDeferred<IMessageSettings>();
  const api: IMessageApi = {
    get: async () => state,
    save: async value => { if (rejectSave) throw new Error('Save failed'); saves++; state = { ...state, ...value }; listener?.(state); return state; },
    test: async () => { sends++; return testResult.promise; },
    onChanged: callback => { listener = callback; return () => { listener = undefined; }; }, reportQueue: async () => {},
    commands: { get: async () => commandState, configure: async () => { commands++; return commandState; } },
  };
  let events: NotificationEventSettings = { completed: true, attention: true, failed: true, error: null };
  let eventsListener: ((value: NotificationEventSettings) => void) | undefined;
  const eventWrites: string[] = [];
  const eventsApi: NotificationEventsApi = {
    reportView: async () => {},
    get: async () => events,
    set: async (kind, enabled) => { eventWrites.push(kind); events = { ...events, [kind]: enabled }; eventsListener?.(events); return events; },
    onChanged: callback => { eventsListener = callback; return () => { eventsListener = undefined; }; },
  };
  let unmount: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const { NotificationSettings } = await import('../frontend/src/features/settings/NotificationSettings');
    const container = globalThis.document.createElement('div'); globalThis.document.body.append(container);
    const root = createRoot(container); unmount = async () => { await act(async () => root.unmount()); };
    await act(async () => root.render(<NotificationSettings api={api} eventsApi={eventsApi} />));
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Enable iMessage notifications"]')!;
    const testButton = container.querySelector<HTMLButtonElement>('[aria-label="Send test iMessage"]')!;
    const saveButton = container.querySelector<HTMLButtonElement>('[aria-label="Save notification settings"]')!;
    const recipient = container.querySelector<HTMLInputElement>('[aria-label="Recipient"]')!;
    const feedback = container.querySelector('[role="status"]')!;
    const completed = container.querySelector<HTMLButtonElement>('[aria-label="Work completed"]')!;
    const commandToggle = container.querySelector<HTMLButtonElement>('[aria-label="Receive instructions from iMessage"]')!;
    const target = container.querySelector<HTMLButtonElement>('[aria-label="iMessage target conversation"]')!;
    const editRecipient = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(recipient, value);
        recipient.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    expect(completed.closest('form')).toBeNull();
    expect(recipient.closest('form')!.querySelector('button')).toBe(toggle);
    expect(recipient.disabled).toBe(true); expect(saveButton.disabled).toBe(true); expect(testButton.disabled).toBe(true);
    expect(commandToggle.disabled).toBe(true); expect(target.disabled).toBe(true); expect(toggle.disabled).toBe(false);
    await act(async () => { saveButton.click(); testButton.click(); commandToggle.click(); target.click(); });
    expect(commands).toBe(0); expect(saves).toBe(0); expect(sends).toBe(0);
    await act(async () => completed.click());
    expect(eventWrites).toEqual(['completed']); expect(events.completed).toBe(false);
    expect(saves).toBe(0); expect(state.enabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false'); expect(sends).toBe(0);
    await act(async () => toggle.click());
    expect(recipient.disabled).toBe(false);
    if (!initialRecipient) {
      expect(saves).toBe(0); expect(testButton.disabled).toBe(true);
      await editRecipient('me@example.com');
      await act(async () => saveButton.click());
    }
    await act(async () => listener?.({ ...state, lastStatus: 'Background status' }));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(saves).toBe(1); expect(state.enabled).toBe(true); expect(testButton.disabled).toBe(false);
    expect(commandToggle.disabled).toBe(false); expect(target.disabled).toBe(false);
    expect(sends).toBe(0);
    await act(async () => testButton.click());
    expect(sends).toBe(1); expect(saveButton.disabled).toBe(true); expect(testButton.disabled).toBe(true);
    expect(recipient.disabled).toBe(false);
    expect(toggle.disabled).toBe(true);
    await editRecipient('draft@example.com');
    expect(container.querySelector('[role="status"]')).toBe(feedback);
    expect(feedback.textContent).toBe('Sending test iMessage…');
    await act(async () => {
      testButton.click(); saveButton.click();
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      toggle.click();
      listener?.({ ...state, lastStatus: 'Submitted to Messages.' });
    });
    expect(sends).toBe(1); expect(saves).toBe(1);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      if (outcome === 'success') testResult.resolve({ ...state, lastStatus: 'Submitted to Messages.' });
      else testResult.reject(new Error('Allow Cheshi to control Messages.'));
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true'); expect(recipient.value).toBe('draft@example.com');
    expect(saveButton.disabled).toBe(false); expect(testButton.disabled).toBe(true);
    expect(container.querySelector(outcome === 'success' ? '[role="status"]' : '[role="alert"]')).toBe(feedback);
    expect(feedback.textContent).toBe(outcome === 'success' ? 'Submitted to Messages.' : 'Allow Cheshi to control Messages.');
    rejectSave = true;
    await act(async () => toggle.click());
    expect(state.enabled).toBe(true); expect(recipient.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Save failed');
    rejectSave = false;
    await act(async () => toggle.click());
    expect(state.enabled).toBe(false); expect(saves).toBe(2); expect(recipient.value).toBe('draft@example.com');
    expect(recipient.disabled).toBe(true); expect(saveButton.disabled).toBe(true); expect(testButton.disabled).toBe(true);
    expect(commandToggle.disabled).toBe(true); expect(target.disabled).toBe(true); expect(completed.disabled).toBe(false);
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(saves).toBe(2);
    await act(async () => toggle.click());
    expect(state.enabled).toBe(true); expect(saves).toBe(3); expect(recipient.value).toBe('draft@example.com');
    expect(recipient.disabled).toBe(false); expect(testButton.disabled).toBe(true);
    await act(async () => saveButton.click());
    expect(state.recipient).toBe('draft@example.com'); expect(testButton.disabled).toBe(false);
  } finally {
    await unmount?.(); expect(listener).toBeUndefined(); expect(eventsListener).toBeUndefined(); await window.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
