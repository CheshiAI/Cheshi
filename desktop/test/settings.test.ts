import { registerSettingsIpc } from '../lib/settings-ipc.mts';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSettingsService } from '../lib/settings-service.mts';
import { createSettingsApi } from '../lib/settings-preload.cts';
import { SETTINGS_CHANNELS, parseFlashReadiness } from '../shared/settings.ts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-settings-'));
  const options = { directory, settingsPath: path.join(directory, 'settings.json') };
  return { options, service: createSettingsService(options), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('Flash defaults off, persists across restarts and accepts only literal booleans', () => {
  const f = fixture();
  try {
    expect(f.service.getFlashEnabled()).toBe(false);
    const seen: boolean[] = [];
    const unsubscribe = f.service.subscribeFlashEnabled(value => seen.push(value));
    f.service.setProjectDocMaxBytes(65536);
    expect(f.service.setFlashEnabled(true)).toBe(true);
    expect(createSettingsService(f.options).getFlashEnabled()).toBe(true);
    expect(f.service.getProjectDocMaxBytes()).toBe(65536);
    for (const value of ['true', 1, null, undefined, {}, []]) {
      expect(() => f.service.setFlashEnabled(value)).toThrow('boolean');
      expect(f.service.getFlashEnabled()).toBe(true);
    }
    f.service.setFlashEnabled(false);
    expect(createSettingsService(f.options).getFlashEnabled()).toBe(false);
    expect(seen).toEqual([true, false]);
    unsubscribe(); f.service.setFlashEnabled(true);
    expect(seen).toEqual([true, false]);
    for (const value of ['true', 1, null, {}, []]) {
      writeFileSync(f.options.settingsPath, JSON.stringify({ flashEnabled: value }));
      expect(f.service.getFlashEnabled()).toBe(false);
    }
  } finally { f.close(); }
});

test('failed Flash persistence never publishes a changed preference', () => {
  const f = fixture();
  try {
    const seen: boolean[] = [];
    f.service.subscribeFlashEnabled(value => seen.push(value));
    writeFileSync(f.options.settingsPath, '{damaged');
    expect(() => f.service.setFlashEnabled(true)).toThrow('Could not save');
    expect(seen).toEqual([]);
    expect(readFileSync(f.options.settingsPath, 'utf8')).toBe('{damaged');
  } finally { f.close(); }
});

test('Flash preferences cross owner-checked IPC, broadcast and validate preload values', async () => {
  const f = fixture();
  const routes = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const events = new EventEmitter();
  const owner = { mainFrame: {}, isDestroyed: () => false,
    send: (channel: string, value: unknown) => events.emit(channel, {}, value) };
  const window = Object.assign(new EventEmitter(), { webContents: owner });
  const registration = registerSettingsIpc({ window: window as unknown as BrowserWindow, service: f.service,
    flash: { ...f.service, setFlashEnabled: async value => f.service.setFlashEnabled(value),
      readiness: async () => ({ ready: true, detail: 'Ready fixture' }) },
    ipc: { handle: (channel, listener) => { routes.set(channel, listener); }, removeHandler: channel => { routes.delete(channel); } } });
  let sender: unknown = owner;
  const ipc = Object.assign(events, { invoke: async (channel: string, value?: unknown) =>
    routes.get(channel)!({ sender, senderFrame: owner.mainFrame } as IpcMainInvokeEvent, value) });
  const api = createSettingsApi(ipc as IpcRenderer);
  const seen: boolean[] = [];
  const unsubscribe = api.onFlashEnabledChanged(value => seen.push(value));
  try {
    expect(await api.getFlashEnabled()).toBe(false);
    expect(await api.setFlashEnabled(true)).toBe(true);
    expect(seen).toEqual([true]);
    sender = {};
    let failure: unknown;
    try { await api.setFlashEnabled(false); } catch (error) { failure = error; }
    expect(String(failure)).toContain('workspace window');
    expect(f.service.getFlashEnabled()).toBe(true);
    const malformed = createSettingsApi({ invoke: async (_channel: string) => 'true',
      on: ipc.on.bind(ipc), removeListener: ipc.removeListener.bind(ipc) } as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>);
    failure = undefined;
    try { await malformed.getFlashEnabled(); } catch (error) { failure = error; }
    expect(String(failure)).toContain('boolean');
    registration.dispose(); f.service.setFlashEnabled(false);
    expect(seen).toEqual([true]);
    expect(routes.size).toBe(0);
  } finally { unsubscribe(); registration.dispose(); f.close(); }
});

test('workspace account selections survive restart and preserve other windows and settings', async () => {
  const f = fixture();
  try {
    writeFileSync(f.options.settingsPath, JSON.stringify({ otherSetting: { keep: true } }));
    const first = f.service.workspaceAccountSelection('/projects/first');
    const second = f.service.workspaceAccountSelection('/projects/second');
    expect(first.read()).toBeNull();
    await Promise.all([
      Promise.resolve().then(() => first.write('first-account')),
      Promise.resolve().then(() => second.write('second-account')),
      Promise.resolve().then(() => f.service.setProjectDocMaxBytes(65536)),
    ]);
    first.write('replacement-account');
    const restarted = createSettingsService(f.options);
    expect(restarted.workspaceAccountSelection('/projects/first').read()).toBe('replacement-account');
    expect(restarted.workspaceAccountSelection('/projects/second').read()).toBe('second-account');
    expect(JSON.parse(readFileSync(f.options.settingsPath, 'utf8'))).toEqual({
      otherSetting: { keep: true }, projectDocMaxBytes: 65536,
      workspaceAccountSelections: {
        '/projects/first': 'replacement-account', '/projects/second': 'second-account',
      },
    });
    expect(statSync(f.options.settingsPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.options.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { f.close(); }
});

test('invalid saved account IDs are ignored and invalid writes preserve settings', () => {
  const f = fixture();
  try {
    const selection = f.service.workspaceAccountSelection('/projects/first');
    for (const value of [null, [], 42, '', '../account', 'a'.repeat(129)]) {
      const previous = JSON.stringify({ workspaceAccountSelections: { '/projects/first': value } });
      writeFileSync(f.options.settingsPath, previous);
      expect(selection.read()).toBeNull();
      expect(() => selection.write('../account')).toThrow('Invalid account');
      expect(readFileSync(f.options.settingsPath, 'utf8')).toBe(previous);
    }
    writeFileSync(f.options.settingsPath, '{damaged');
    expect(() => selection.read()).toThrow('Could not read');
    expect(() => selection.write('second')).toThrow('Could not save');
    expect(readFileSync(f.options.settingsPath, 'utf8')).toBe('{damaged');
  } finally { f.close(); }
});

test('failure to create the temporary settings file retains the previous selection', () => {
  const f = fixture();
  try {
    // The settings filename fits the filesystem limit; the UUID suffix cannot.
    const settingsPath = path.join(f.options.directory, 's'.repeat(240));
    const previous = JSON.stringify({ workspaceAccountSelections: { '/projects/first': 'previous' } });
    writeFileSync(settingsPath, previous);
    const selection = createSettingsService({ ...f.options, settingsPath }).workspaceAccountSelection('/projects/first');
    expect(() => selection.write('replacement')).toThrow('Could not save');
    expect(selection.read()).toBe('previous');
    expect(readFileSync(settingsPath, 'utf8')).toBe(previous);
  } finally { f.close(); }
});

test('instruction limit defaults to 32 KiB, persists independently and rejects invalid values', () => {
  const f = fixture();
  try {
    expect(f.service.getProjectDocMaxBytes()).toBe(32768);
    const seen: number[] = [];
    const unsubscribe = f.service.subscribeProjectDocMaxBytes(value => seen.push(value));
    expect(f.service.setProjectDocMaxBytes(131072)).toBe(131072);
    expect(createSettingsService(f.options).getProjectDocMaxBytes()).toBe(131072);
    for (const value of [null, undefined, true, '131072', 0, -1024, 1.5, 1025, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => f.service.setProjectDocMaxBytes(value)).toThrow('whole number');
    }
    expect(f.service.getProjectDocMaxBytes()).toBe(131072);
    expect(seen).toEqual([131072]);
    unsubscribe(); f.service.setProjectDocMaxBytes(32768);
    expect(seen).toEqual([131072]);
  } finally { f.close(); }
});

test('instruction preference failures leave saved data untouched and do not publish success', () => {
  const f = fixture();
  try {
    writeFileSync(f.options.settingsPath, '{damaged');
    const seen: number[] = [];
    f.service.subscribeProjectDocMaxBytes(value => seen.push(value));
    expect(() => f.service.getProjectDocMaxBytes()).toThrow('Could not read');
    expect(() => f.service.setProjectDocMaxBytes(131072)).toThrow('Could not save');
    expect(readFileSync(f.options.settingsPath, 'utf8')).toBe('{damaged');
    expect(seen).toEqual([]);
  } finally { f.close(); }
});

test('settings preload exposes preferences and validates instruction replies', async () => {
  const calls: string[] = [];
  let reply: unknown = 32768;
  const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string) => { calls.push(channel); return reply; } });
  const api = createSettingsApi(ipc as IpcRenderer);
  expect(Object.keys(api).sort()).toEqual(['getFlashEnabled', 'getFlashReadiness', 'getProjectDocMaxBytes', 'installFlash', 'onFlashEnabledChanged', 'onProjectDocMaxBytesChanged', 'setFlashEnabled', 'setProjectDocMaxBytes']);
  expect(await api.getProjectDocMaxBytes()).toBe(32768);
  expect(await api.setProjectDocMaxBytes(32768)).toBe(32768);
  expect(calls).toEqual([SETTINGS_CHANNELS.getProjectDocMaxBytes, SETTINGS_CHANNELS.setProjectDocMaxBytes]);
  reply = '32768';
  let failure: unknown;
  try { await api.getProjectDocMaxBytes(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
});

test('Flash readiness accepts only literal booleans at the preload boundary', () => {
  for (const value of [null, { ready: 'true', detail: 'missing' }, { ready: true }, { ready: true, detail: 'ok', installing: 1 }]) {
    expect(() => parseFlashReadiness(value)).toThrow('Invalid Flash readiness');
  }
  expect(parseFlashReadiness({ ready: false, detail: 'Missing model', installing: true }))
    .toEqual({ ready: false, detail: 'Missing model', installing: true });
});

test('settings IPC retains owner checks and subscriptions without provider routes', () => {
  const f = fixture();
  const routes = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const sent: number[] = [];
  const owner = { mainFrame: {}, isDestroyed: () => false, send: (channel: string, value: number) => {
    if (channel === SETTINGS_CHANNELS.projectDocMaxBytesChanged) sent.push(value);
  } };
  const window = Object.assign(new EventEmitter(), { webContents: owner });
  const registration = registerSettingsIpc({ window: window as unknown as BrowserWindow, service: f.service,
    ipc: { handle: (channel, listener) => { routes.set(channel, listener); }, removeHandler: channel => { routes.delete(channel); } } });
  const invoke = (channel: string, value?: unknown, sender: unknown = owner, frame: unknown = owner.mainFrame) =>
    routes.get(channel)!({ sender, senderFrame: frame } as IpcMainInvokeEvent, value);
  try {
    expect([...routes.keys()].sort()).toEqual([SETTINGS_CHANNELS.getProjectDocMaxBytes, SETTINGS_CHANNELS.setProjectDocMaxBytes,
      SETTINGS_CHANNELS.getFlashEnabled, SETTINGS_CHANNELS.setFlashEnabled, SETTINGS_CHANNELS.getFlashReadiness, SETTINGS_CHANNELS.installFlash].sort());
    expect(() => invoke(SETTINGS_CHANNELS.setFlashEnabled, true)).toThrow('verification is unavailable');
    expect(invoke(SETTINGS_CHANNELS.setFlashEnabled, false)).toBe(false);
    expect(() => invoke(SETTINGS_CHANNELS.setProjectDocMaxBytes, 131072, {})).toThrow('workspace window');
    expect(() => invoke(SETTINGS_CHANNELS.setProjectDocMaxBytes, 131072, owner, {})).toThrow('workspace window');
    expect(() => invoke(SETTINGS_CHANNELS.setProjectDocMaxBytes, '131072')).toThrow('whole number');
    expect(invoke(SETTINGS_CHANNELS.getProjectDocMaxBytes)).toBe(32768);
    expect(invoke(SETTINGS_CHANNELS.setProjectDocMaxBytes, 131072)).toBe(131072);
    expect(sent).toEqual([131072]);
    registration.dispose();
    f.service.setProjectDocMaxBytes(32768);
    expect(sent).toEqual([131072]); expect(routes.size).toBe(0);
  } finally { registration.dispose(); f.close(); }
});
