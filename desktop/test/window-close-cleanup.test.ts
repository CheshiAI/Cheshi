import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { onWindowClosed } from '../lib/window-close-cleanup.mts';
import { registerSettingsIpc } from '../lib/settings-ipc.mts';
import { registerNotificationEventsIpc } from '../lib/notification-events-ipc.mts';
import { registerIMessageIpc } from '../lib/imessage-ipc.mts';
import { registerDiscordIpc } from '../lib/discord-ipc.mts';
import { registerAgentManagementIpc } from '../lib/agent-management/ipc.mts';

test('many cleanup registrations share one listener and run once in registration order', () => {
  const window = new EventEmitter(), calls: number[] = [];
  const unsubscribe = Array.from({ length: 20 }, (_, index) => onWindowClosed(window, () => { calls.push(index); }));
  expect(window.listenerCount('closed')).toBe(1);
  expect(window.getMaxListeners()).toBe(10);
  unsubscribe[3]!();
  window.emit('closed');
  expect(calls).toEqual(Array.from({ length: 20 }, (_, index) => index).filter(index => index !== 3));
  window.emit('closed');
  for (const remove of unsubscribe) remove();
  expect(calls).toHaveLength(19);
  expect(window.listenerCount('closed')).toBe(0);
});

test('repeated attach and detach preserves other listeners and separate windows', () => {
  const window = new EventEmitter(), other = new EventEmitter();
  const existing = () => {};
  window.on('closed', existing);
  let calls = 0;
  const callback = () => { calls++; };
  const detachOther = onWindowClosed(other, callback);
  for (let index = 0; index < 20; index++) {
    const first = onWindowClosed(window, callback), second = onWindowClosed(window, callback);
    expect(window.listenerCount('closed')).toBe(2);
    first(); first();
    expect(window.listenerCount('closed')).toBe(2);
    second();
    expect(window.listeners('closed')).toEqual([existing]);
  }
  window.emit('closed');
  expect(calls).toBe(0);
  other.emit('closed');
  detachOther();
  expect(calls).toBe(1);
});

test('cleanup errors are reported without blocking remaining services or close completion', () => {
  const window = new EventEmitter(), calls: string[] = [];
  const error = new Error('cleanup fixture');
  const report = spyOn(console, 'error').mockImplementation(() => {});
  try {
    onWindowClosed(window, () => { throw error; });
    onWindowClosed(window, () => { calls.push('service'); });
    window.once('closed', () => { calls.push('complete'); });
    window.emit('closed');
    expect(calls).toEqual(['service', 'complete']);
    expect(report).toHaveBeenCalledWith('[cheshi] Window close cleanup failed:', error);
    onWindowClosed(window, () => { calls.push('late'); });
    expect(calls).toEqual(['service', 'complete', 'late']);
    expect(window.listenerCount('closed')).toBe(0);
  } finally { report.mockRestore(); }
});

test('workspace IPC services share cleanup and release subscriptions and channels across cycles', () => {
  const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const ipc = { handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); } };
  let subscriptions = 0, terminalCloses = 0;
  const service = { subscribe: () => { subscriptions++; return () => { subscriptions--; }; } };
  for (let cycle = 0; cycle < 3; cycle++) {
    const registrations = [
      registerSettingsIpc({ window, ipc, service: service as unknown as Parameters<typeof registerSettingsIpc>[0]['service'] }),
      registerNotificationEventsIpc({ window, ipc, service: service as unknown as Parameters<typeof registerNotificationEventsIpc>[0]['service'] }),
      registerIMessageIpc({ window, ipc, service: service as unknown as Parameters<typeof registerIMessageIpc>[0]['service'] }),
      registerDiscordIpc({ window, ipc, service: {} as Parameters<typeof registerDiscordIpc>[0]['service'], setup: async () => 'unused' }),
      registerAgentManagementIpc({ window, ipc, service: {} as Parameters<typeof registerAgentManagementIpc>[0]['service'],
        terminal: { open: async () => { throw new Error('unused'); }, update: async () => {}, close: async () => {},
          dispose: () => { terminalCloses++; } } }),
    ];
    expect(window.listenerCount('closed')).toBe(1);
    expect(subscriptions).toBe(3);
    expect(handlers.size).toBeGreaterThan(0);
    if (cycle === 2) window.emit('closed');
    for (const registration of registrations) { registration.dispose(); registration.dispose(); }
    expect(window.listenerCount('closed')).toBe(0);
    expect(owner.listenerCount('destroyed')).toBe(0);
    expect(handlers.size).toBe(0);
    expect(subscriptions).toBe(0);
    expect(terminalCloses).toBe(cycle + 1);
  }
});
