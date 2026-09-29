import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcRenderer, WebContents } from 'electron';
import { createSchedulerApi } from '../lib/scheduler-preload.cts';
import { createSchedulerSubscriptions } from '../lib/scheduler/subscriptions.mts';
import { SCHEDULER_CHANGED_CHANNEL } from '../shared/scheduler';
import { createSchedulerDeferred } from './scheduler-test-clock';

function fixture() {
  const subscribers = createSchedulerSubscriptions();
  const renderer = new EventEmitter();
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    send(channel: string) { renderer.emit(channel); } });
  const boundary = sender as unknown as WebContents;
  const ipc = Object.assign(renderer, { async invoke(_channel: string, method: string, token: string) {
    if (method === 'subscribe') subscribers.add(boundary, token);
    else if (method === 'unsubscribe') subscribers.remove(boundary, token);
  } }) as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;
  return { subscribers, renderer, sender, ipc };
}
test('preload refreshes after registration, shares sender delivery, and removes the final subscription', async () => {
  const value = fixture(); const api = createSchedulerApi(value.ipc); let one = 0; let two = 0;
  const removeOne = api.onChanged(() => one++); const removeTwo = api.onChanged(() => two++);
  await Promise.resolve(); expect(one).toBe(1); expect(two).toBe(1);
  value.subscribers.changed(); expect(one).toBe(2); expect(two).toBe(2);
  removeOne(); value.subscribers.changed(); expect(one).toBe(2); expect(two).toBe(3);
  removeTwo(); expect(value.renderer.listenerCount(SCHEDULER_CHANGED_CHANNEL)).toBe(0);
  expect(value.sender.listenerCount('destroyed')).toBe(0); value.subscribers.dispose();
});
test('closing before registration completes suppresses late callbacks and reports subscription failures', async () => {
  const value = fixture(); const gate = createSchedulerDeferred<void>(); let changed = 0;
  const original = value.ipc.invoke;
  value.ipc.invoke = async (...args: Parameters<IpcRenderer['invoke']>) => { await gate.promise; return original(...args); };
  const api = createSchedulerApi(value.ipc); const remove = api.onChanged(() => changed++);
  remove(); gate.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(changed).toBe(0); expect(value.sender.listenerCount('destroyed')).toBe(0);
  value.ipc.invoke = async () => { throw new Error('Workspace closed'); };
  const errors: string[] = []; const off = api.onChanged(() => changed++, message => errors.push(message));
  await Promise.resolve(); await Promise.resolve(); expect(errors).toEqual(['Workspace closed']); off(); value.subscribers.dispose();
});
test('navigation, destroyed windows, and workspace disposal release push listeners', () => {
  for (const action of ['navigate', 'destroy', 'dispose']) {
    const value = fixture(); const api = createSchedulerApi(value.ipc); let changed = 0;
    const off = api.onChanged(() => changed++);
    if (action === 'navigate') value.sender.emit('did-start-navigation', {}, 'about:blank', false, true);
    else if (action === 'destroy') value.sender.emit('destroyed');
    else value.subscribers.dispose();
    value.subscribers.changed(); expect(changed).toBe(0);
    expect(value.sender.listenerCount('destroyed')).toBe(0); off();
  }
});
