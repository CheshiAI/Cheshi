import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { createNotificationVisibility } from '../lib/notification-visibility.mts';
import { createWorkspaceNotifications } from '../lib/workspace-notifications.mts';
import type { WorkspaceIpcScope } from '../lib/workspace-ipc-router.mts';
import type { ChatNotification } from '../lib/imessage-notifications.mts';
import { createNotificationEventsApi } from '../lib/notification-events-preload.cts';

function fixture() {
  const handlers = new Map<string, Parameters<WorkspaceIpcScope['ipc']['handle']>[1]>();
  const owner = Object.assign(new EventEmitter(), { mainFrame: {} });
  const state = { focused: true, minimized: false, visible: true, destroyed: false };
  const window = { webContents: owner, isFocused: () => state.focused, isVisible: () => state.visible,
    isMinimized: () => state.minimized, isDestroyed: () => state.destroyed };
  const ipc = { handle: (name: string, handler: Parameters<WorkspaceIpcScope['ipc']['handle']>[1]) => { handlers.set(name, handler); },
    removeHandler: (name: string) => { handlers.delete(name); } } as WorkspaceIpcScope['ipc'];
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const api = createNotificationEventsApi({ invoke: async (channel, ...args) => handlers.get(channel)!(event, ...args) } as Parameters<typeof createNotificationEventsApi>[0]);
  return { handlers, owner, state, ipc, api, event, getParent: () => window as unknown as BrowserWindow };
}

test('only conversations visible in a foreground window suppress notifications, including split panes', async () => {
  const f = fixture(), visibility = createNotificationVisibility(f);
  try {
    expect(visibility.isViewed('one')).toBe(false);
    await f.api.reportView('main', 'one'); await f.api.reportView('split', 'two');
    expect(visibility.isViewed('one')).toBe(true); expect(visibility.isViewed('two')).toBe(true);
    expect(visibility.isViewed('background-thread')).toBe(false);
    await f.api.reportView('main', 'three');
    expect(visibility.isViewed('one')).toBe(false); expect(visibility.isViewed('three')).toBe(true);
    for (const flag of ['minimized', 'destroyed'] as const) {
      f.state[flag] = true; expect(visibility.isViewed('three')).toBe(false); f.state[flag] = false;
    }
    for (const flag of ['focused', 'visible'] as const) {
      f.state[flag] = false; expect(visibility.isViewed('three')).toBe(false); f.state[flag] = true;
    }
    await f.api.reportView('main', null); expect(visibility.isViewed('three')).toBe(false);
    visibility.remove('split'); expect(visibility.isViewed('two')).toBe(false);
    await f.api.reportView('main', 'one');
    f.owner.emit('did-start-navigation', {}, 'url', false, true);
    expect(visibility.isViewed('one')).toBe(false);
    await f.api.reportView('main', 'one'); f.owner.emit('render-process-gone');
    expect(visibility.isViewed('one')).toBe(false);
  } finally { visibility.dispose(); }
  expect(f.handlers.size).toBe(0); expect(f.owner.listenerCount('destroyed')).toBe(0);
});

test('visibility reports reject foreign windows, frames and malformed state', () => {
  const f = fixture(), visibility = createNotificationVisibility(f);
  const handle = f.handlers.get('cheshi:notification-events:view')!;
  try {
    for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
      expect(() => handle(event as IpcMainInvokeEvent, { contextId: 'main', threadId: 'one' })).toThrow('owner');
    }
    for (const value of [null, { contextId: '', threadId: 'one' }, { contextId: 'main', threadId: true },
      { contextId: 'main', threadId: '' }]) expect(() => handle(f.event, value)).toThrow('visibility');
    expect(visibility.isViewed('one')).toBe(false);
  } finally { visibility.dispose(); }
});

test('workspace notifications carry a live viewing check through queueing and temporary windows', async () => {
  const f = fixture(), events: ChatNotification[] = [];
  const notifications = createWorkspaceNotifications({ workspaceRoot: '/project', getParent: f.getParent,
    scope: { ipc: f.ipc } as WorkspaceIpcScope, sink: { notify: event => events.push(event) } });
  try {
    await f.api.reportView('main', 'one');
    notifications.event('main', { type: 'approval-requested', threadId: 'one', approval: { id: 'a' } });
    expect(events[0]?.isViewed?.()).toBe(true);
    f.state.focused = false; expect(events[0]?.isViewed?.()).toBe(false);
    f.state.focused = true; await f.api.reportView('main', 'two'); expect(events[0]?.isViewed?.()).toBe(false);
    await f.api.reportView('main', 'one'); expect(events[0]?.isViewed?.()).toBe(true);
    notifications.remove('main'); expect(events[0]?.isViewed?.()).toBe(false);
    const temporary = notifications.temporary({ models: async () => [], send: async () => { throw new Error('test failure'); }, close: async () => {} }, f.getParent());
    try { await temporary.send({}); } catch { /* Expected failure produces a notification. */ }
    expect(events.at(-1)?.kind).toBe('failed'); expect(events.at(-1)?.isViewed?.()).toBe(true);
    f.state.focused = false; expect(events.at(-1)?.isViewed?.()).toBe(false);
    await temporary.close(); expect(events.at(-1)?.isViewed?.()).toBe(true);
  } finally { notifications.dispose(); }
});
