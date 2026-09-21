import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import { createSettingsService } from '../lib/settings-service.mts';
import { registerSettingsIpc } from '../lib/settings-ipc.mts';
import { createSettingsApi } from '../lib/settings-preload.cts';
import { SETTINGS_CHANNELS, parseTypeSafeSettings, type TypeSafeSettings } from '../shared/settings.ts';

const key = 'fixture-secret-typesafe-key-12345';
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-settings-'));
  const encryptionKey = randomBytes(32);
  let available = true, failEncryption = false;
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString(value: string) {
      if (failEncryption) throw new Error(value);
      const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', encryptionKey, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final()]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv('aes-256-cbc', encryptionKey, value.subarray(0, 16));
      return Buffer.concat([decipher.update(value.subarray(16)), decipher.final()]).toString('utf8');
    },
  };
  const options = { directory, settingsPath: path.join(directory, 'settings.json'), encryption, fallback: () => 'environment-fixture-key', checkKey: async (_key: string) => {} };
  return { options, service: createSettingsService(options), filename: path.join(directory, 'typesafe-api-key.enc'),
    lock() { available = false; }, failEncryption() { failEncryption = true; }, close() { rmSync(directory, { recursive: true, force: true }); } };
}
async function rejected(operation: Promise<unknown>, expected: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(expected);
  expect((failure as Error).message).not.toContain(key);
}

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
      Promise.resolve().then(() => f.service.setHistoryRecallEnabled(true)),
    ]);
    first.write('replacement-account');
    const restarted = createSettingsService(f.options);
    expect(restarted.workspaceAccountSelection('/projects/first').read()).toBe('replacement-account');
    expect(restarted.workspaceAccountSelection('/projects/second').read()).toBe('second-account');
    expect(JSON.parse(readFileSync(f.options.settingsPath, 'utf8'))).toEqual({
      otherSetting: { keep: true }, historyRecallEnabled: true,
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

test('keys persist encrypted, survive restart and only expose masked metadata', () => {
  const f = fixture();
  try {
    const saved = f.service.save(key);
    expect(saved).toEqual({ source: 'saved', maskedKey: '••••2345', canSave: true, error: null, historyRecallEnabled: false });
    expect(readFileSync(f.filename).includes(Buffer.from(key))).toBe(false);
    expect(statSync(f.filename).mode & 0o777).toBe(0o600);
    expect(createSettingsService(f.options).getKey()).toBe(key);
    expect(JSON.stringify(parseTypeSafeSettings(saved))).not.toContain(key);
    expect(f.service.remove().source).toBe('environment');
    expect(f.service.getKey()).toBe('environment-fixture-key');
    expect(createSettingsService({ ...f.options, fallback: () => null }).snapshot().source).toBe('none');
  } finally { f.close(); }
});

test('failed replacement retains the previous key and unavailable storage never writes plaintext', () => {
  const f = fixture();
  try {
    f.service.save(key);
    const previous = readFileSync(f.filename);
    f.failEncryption();
    expect(() => f.service.save('replacement-fixture')).toThrow('previous key was retained');
    expect(readFileSync(f.filename)).toEqual(previous);
    expect(f.service.getKey()).toBe(key);
    f.lock();
    expect(() => f.service.save(key)).toThrow('not saved');
    expect(f.service.snapshot().canSave).toBe(false);
    expect(f.service.getKey()).toBeNull();
  } finally { f.close(); }
});

test('damaged ciphertext fails closed and short keys never appear in full', () => {
  const f = fixture();
  try {
    expect(f.service.save('tiny').maskedKey).toBe('••••');
    writeFileSync(f.filename, Buffer.from('damaged'));
    const restarted = createSettingsService(f.options);
    expect(restarted.getKey()).toBeNull();
    expect(restarted.snapshot().error).toContain('could not be unlocked');
    expect(() => f.service.save('bad\nkey')).toThrow('without spaces');
    expect(() => f.service.save('x'.repeat(4097))).toThrow();
    expect(() => parseTypeSafeSettings({ ...f.service.snapshot(), maskedKey: key })).toThrow();
    expect(() => parseTypeSafeSettings({ ...f.service.snapshot(), canSave: 'true' })).toThrow();
  } finally { f.close(); }
});

test('provider connection failures never expose arbitrary messages or keys', async () => {
  const f = fixture();
  try {
    const failing = createSettingsService({ ...f.options, checkKey: async value => { throw new Error(value); } });
    failing.save(key);
    await rejected(failing.check(), 'Could not verify');
    const limited = createSettingsService({ ...f.options, checkKey: async () => { throw new Error('TypeSafe usage limit reached. Try again later.'); } });
    await rejected(limited.check(), 'usage limit');
  } finally { f.close(); }
});

test('settings IPC rejects foreign renderers and subframes and cleans up handlers and subscriptions', async () => {
  const f = fixture();
  const routes = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const sent: unknown[] = [];
  const owner = { mainFrame: {}, isDestroyed: () => false, send: (_channel: string, value: unknown) => sent.push(value) };
  const window = Object.assign(new EventEmitter(), { webContents: owner });
  const registration = registerSettingsIpc({ window: window as unknown as BrowserWindow, service: f.service,
    ipc: { handle: (channel, listener) => { routes.set(channel, listener); }, removeHandler: channel => { routes.delete(channel); } } });
  const invoke = (channel: string, value?: unknown, sender: unknown = owner, frame: unknown = owner.mainFrame) =>
    routes.get(channel)!({ sender, senderFrame: frame } as IpcMainInvokeEvent, value);
  try {
    expect(() => invoke(SETTINGS_CHANNELS.save, key, {})).toThrow('workspace window');
    expect(() => invoke(SETTINGS_CHANNELS.save, key, owner, {})).toThrow('workspace window');
    expect(invoke(SETTINGS_CHANNELS.save, key).source).toBe('saved');
    expect(() => invoke(SETTINGS_CHANNELS.setHistoryRecallEnabled, true, {})).toThrow('workspace window');
    expect(() => invoke(SETTINGS_CHANNELS.setHistoryRecallEnabled, true, owner, {})).toThrow('workspace window');
    expect(() => invoke(SETTINGS_CHANNELS.setHistoryRecallEnabled, 'true')).toThrow('Invalid');
    expect(invoke(SETTINGS_CHANNELS.setHistoryRecallEnabled, true).historyRecallEnabled).toBe(true);
    expect(await invoke(SETTINGS_CHANNELS.check)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(key);
    registration.dispose();
    const count = sent.length;
    f.service.remove();
    expect(sent).toHaveLength(count);
    expect(routes.size).toBe(0);
  } finally { registration.dispose(); f.close(); }
});

test('preload validates both requests and status replies without exposing full keys', async () => {
  const calls: unknown[][] = [];
  let response: unknown = { source: 'saved', maskedKey: '••••2345', canSave: true, error: null, historyRecallEnabled: false };
  const ipc = { invoke: async (...values: unknown[]) => { calls.push(values); return response; },
    on() {}, removeListener() {} } as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;
  const api = createSettingsApi(ipc);
  expect((await api.saveTypeSafe(key)).maskedKey).toBe('••••2345');
  expect(calls[0]).toEqual([SETTINGS_CHANNELS.save, key]);
  expect((await api.setHistoryRecallEnabled(false)).historyRecallEnabled).toBe(false);
  expect(calls[1]).toEqual([SETTINGS_CHANNELS.setHistoryRecallEnabled, false]);
  await rejected(api.setHistoryRecallEnabled('true' as unknown as boolean), 'Invalid');
  await rejected(api.saveTypeSafe('invalid key'), 'valid');
  response = { source: 'saved', maskedKey: key, canSave: true, error: null, historyRecallEnabled: false };
  await rejected(api.getTypeSafe(), 'Invalid');
  response = 'true';
  await rejected(api.checkTypeSafe(), 'Invalid');
});

test('recall preferences survive service restart and retain unrelated app settings', () => {
  const f = fixture();
  try {
    expect(f.service.snapshot().historyRecallEnabled).toBe(false);
    writeFileSync(f.options.settingsPath, JSON.stringify({ otherSetting: 'retained' }));
    f.service.save(key);
    const states: TypeSafeSettings[] = [];
    const unsubscribe = f.service.subscribe(state => states.push(state));
    expect(f.service.setHistoryRecallEnabled(true).historyRecallEnabled).toBe(true);
    expect(states.at(-1)?.historyRecallEnabled).toBe(true);
    expect(JSON.parse(readFileSync(f.options.settingsPath, 'utf8'))).toEqual({ otherSetting: 'retained', historyRecallEnabled: true });
    expect(readFileSync(f.options.settingsPath, 'utf8')).not.toContain(key);
    expect(statSync(f.options.settingsPath).mode & 0o777).toBe(0o600);
    const restarted = createSettingsService(f.options);
    expect(restarted.snapshot().historyRecallEnabled).toBe(true);
    restarted.setHistoryRecallEnabled(false);
    expect(createSettingsService(f.options).snapshot().historyRecallEnabled).toBe(false);
    unsubscribe();
  } finally { f.close(); }
});

test('only literal true enables the saved preference and invalid requests never overwrite it', () => {
  const f = fixture();
  try {
    for (const invalid of ['true', 1, null, [], {}]) {
      writeFileSync(f.options.settingsPath, JSON.stringify({ historyRecallEnabled: invalid }));
      expect(createSettingsService(f.options).snapshot().historyRecallEnabled).toBe(false);
      expect(() => f.service.setHistoryRecallEnabled(invalid)).toThrow('Invalid');
      expect(() => parseTypeSafeSettings({ ...f.service.snapshot(), historyRecallEnabled: invalid })).toThrow('Invalid');
    }
    f.service.setHistoryRecallEnabled(true);
    expect(() => f.service.setHistoryRecallEnabled('false')).toThrow('Invalid');
    expect(createSettingsService(f.options).snapshot().historyRecallEnabled).toBe(true);
  } finally { f.close(); }
});

test('recall consent is independent of missing, locked or deleted keys', () => {
  const f = fixture();
  try {
    const service = createSettingsService({ ...f.options, fallback: () => null });
    expect(service.setHistoryRecallEnabled(true).historyRecallEnabled).toBe(true);
    service.save(key);
    service.setHistoryRecallEnabled(true);
    f.lock();
    expect(service.snapshot().historyRecallEnabled).toBe(true);
    expect(service.snapshot().maskedKey).toBeNull();
    expect(service.setHistoryRecallEnabled(true).historyRecallEnabled).toBe(true);
    service.remove();
    expect(createSettingsService(f.options).snapshot().historyRecallEnabled).toBe(true);
  } finally { f.close(); }
});

test('removing a saved key preserves the recall preference when an environment key remains', () => {
  const f = fixture();
  try {
    f.service.save(key);
    f.service.setHistoryRecallEnabled(true);
    expect(f.service.remove()).toMatchObject({ source: 'environment', historyRecallEnabled: true });
    expect(createSettingsService(f.options).snapshot().historyRecallEnabled).toBe(true);
  } finally { f.close(); }
});

test('failed preference writes do not publish success or damage the existing settings', () => {
  const f = fixture();
  try {
    writeFileSync(f.options.settingsPath, '{damaged');
    const states: TypeSafeSettings[] = [];
    f.service.subscribe(state => states.push(state));
    expect(f.service.snapshot().error).toContain('Could not read');
    expect(() => f.service.setHistoryRecallEnabled(true)).toThrow('Could not save');
    expect(readFileSync(f.options.settingsPath, 'utf8')).toBe('{damaged');
    expect(states).toHaveLength(0);
    rmSync(f.options.settingsPath);
    mkdirSync(f.options.settingsPath);
    expect(() => f.service.setHistoryRecallEnabled(true)).toThrow('Could not save');
    expect(states).toHaveLength(0);
  } finally { f.close(); }
});

test('separate workspace IPC clients share recall changes and a fresh client restores them', async () => {
  const f = fixture();
  const registrations: Array<ReturnType<typeof registerSettingsIpc>> = [];
  const client = (service = f.service) => {
    const routes = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const events = new EventEmitter();
    const owner = { mainFrame: {}, isDestroyed: () => false,
      send: (channel: string, value: unknown) => events.emit(channel, {}, value) };
    const window = Object.assign(new EventEmitter(), { webContents: owner });
    registrations.push(registerSettingsIpc({ window: window as unknown as BrowserWindow, service,
      ipc: { handle: (channel, handler) => { routes.set(channel, handler); }, removeHandler: channel => { routes.delete(channel); } } }));
    return createSettingsApi({
      invoke: async (channel: string, ...args: unknown[]) => routes.get(channel)!({ sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent, ...args),
      on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    } as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>);
  };
  try {
    const first = client(), second = client();
    const seen: TypeSafeSettings[] = [];
    const unsubscribe = second.onTypeSafeChanged(state => seen.push(state));
    await first.setHistoryRecallEnabled(true);
    expect(seen.at(-1)?.historyRecallEnabled).toBe(true);
    expect((await second.getTypeSafe()).historyRecallEnabled).toBe(true);
    expect((await client(createSettingsService(f.options)).getTypeSafe()).historyRecallEnabled).toBe(true);
    unsubscribe();
  } finally { for (const registration of registrations) registration.dispose(); f.close(); }
});


test('existing Autopilot preferences and saved keys never opt users into recall', () => {
  const f = fixture();
  try {
    writeFileSync(f.options.settingsPath, JSON.stringify({ autopilotMenuVisible: true }));
    f.service.save(key);
    expect(f.service.snapshot().historyRecallEnabled).toBe(false);
    expect(f.service.isHistoryRecallEnabled()).toBe(false);
    expect(createSettingsService(f.options).isHistoryRecallEnabled()).toBe(false);
    f.service.setHistoryRecallEnabled(true);
    expect(f.service.isHistoryRecallEnabled()).toBe(true);
    writeFileSync(f.options.settingsPath, '{damaged');
    expect(f.service.isHistoryRecallEnabled()).toBe(false);
  } finally { f.close(); }
});
