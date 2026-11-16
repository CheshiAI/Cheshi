import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createNotificationEvents } from '../lib/notification-events.mts';
import { registerNotificationEventsIpc } from '../lib/notification-events-ipc.mts';
import { createNotificationEventsApi } from '../lib/notification-events-preload.cts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-notification-events-'));
  const options = { filename: path.join(directory, 'events.json'), legacyIMessageFilename: path.join(directory, 'imessage.json') };
  return { options, create: () => createNotificationEvents(options), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('legacy iMessage event selections migrate once without changing delivery settings', () => {
  const f = fixture();
  const legacy = { enabled: false, recipient: 'test@example.com', completed: false, attention: true, failed: false };
  try {
    writeFileSync(f.options.legacyIMessageFilename, JSON.stringify(legacy));
    const service = f.create();
    expect(service.get()).toEqual({ completed: false, attention: true, failed: false, error: null });
    expect(JSON.parse(readFileSync(f.options.legacyIMessageFilename, 'utf8'))).toEqual(legacy);
    expect(JSON.parse(readFileSync(f.options.filename, 'utf8'))).toEqual({ completed: false, attention: true, failed: false });
    service.set('failed', true);
    writeFileSync(f.options.legacyIMessageFilename, JSON.stringify({ ...legacy, completed: true }));
    expect(f.create().get()).toEqual({ completed: false, attention: true, failed: true, error: null });
  } finally { f.close(); }
});

test('fresh settings default on, strict switches update only one event, and failed saves preserve state', () => {
  const f = fixture();
  try {
    const service = f.create();
    expect(service.get()).toEqual({ completed: true, attention: true, failed: true, error: null });
    for (const value of [1, 'true', null, undefined]) expect(() => service.set('completed', value)).toThrow();
    expect(() => service.set('unknown', false)).toThrow();
    service.set('attention', false); service.set('failed', false);
    expect(service.allows('completed')).toBe(true); expect(service.allows('attention')).toBe(false);
    rmSync(f.options.filename); rmSync(path.dirname(f.options.filename), { recursive: true });
    writeFileSync(path.dirname(f.options.filename), 'not a directory');
    expect(() => service.set('completed', false)).toThrow();
    expect(service.allows('completed')).toBe(true);
  } finally { f.close(); }
});

test.each(['current', 'legacy'])('invalid %s settings fail closed without overwriting them', location => {
  const f = fixture();
  const filename = location === 'current' ? f.options.filename : f.options.legacyIMessageFilename;
  try {
    writeFileSync(filename, '{invalid json');
    const service = f.create();
    expect(service.get().error).not.toBeNull(); expect(service.allows('completed')).toBe(false);
    expect(() => service.set('completed', true)).toThrow();
    expect(readFileSync(filename, 'utf8')).toBe('{invalid json');
  } finally { f.close(); }
});

test.each([null, [], true, { completed: 'false', attention: true, failed: true }].map(legacy => ({ legacy })))('malformed legacy selections are not converted into enabled events: %j', ({ legacy }) => {
  const f = fixture();
  try {
    writeFileSync(f.options.legacyIMessageFilename, JSON.stringify(legacy));
    const service = f.create();
    expect(service.get().error).not.toBeNull();
    expect(service.allows('completed')).toBe(false);
    expect(JSON.parse(readFileSync(f.options.legacyIMessageFilename, 'utf8'))).toEqual(legacy);
  } finally { f.close(); }
});

test('event IPC synchronizes windows, validates ownership and cleans subscriptions', async () => {
  const f = fixture(), service = f.create();
  function windowBridge() {
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>(), renderer = new EventEmitter();
    const owner = { mainFrame: {}, isDestroyed: () => false, send: (channel: string, value: unknown) => { renderer.emit(channel, {}, value); } };
    const window = Object.assign(new EventEmitter(), { webContents: owner });
    const registration = registerNotificationEventsIpc({ window: window as unknown as BrowserWindow, service,
      ipc: { handle: (name, handler) => { handlers.set(name, handler); }, removeHandler: name => { handlers.delete(name); } } });
    const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
    const bridge = Object.assign(renderer, { invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) });
    const api = createNotificationEventsApi(bridge as unknown as Parameters<typeof createNotificationEventsApi>[0]);
    return { registration, api, event, handlers, window };
  }
  const a = windowBridge(), b = windowBridge();
  const received: unknown[] = [], unsubscribe = b.api.onChanged(value => received.push(value));
  try {
    expect((await a.api.get()).completed).toBe(true);
    await a.api.set('completed', false);
    expect(received).toEqual([{ completed: false, attention: true, failed: true, error: null }]);
    for (const event of [{ ...a.event, sender: {} }, { ...a.event, senderFrame: {} }]) {
      expect(() => a.handlers.get('cheshi:notification-events:set')!(event as IpcMainInvokeEvent, 'failed', false)).toThrow('owner');
    }
    a.window.emit('closed'); expect(a.handlers.size).toBe(0);
    unsubscribe(); await b.api.set('failed', false); expect(received).toHaveLength(1);
  } finally { a.registration.dispose(); b.registration.dispose(); f.close(); }
});
