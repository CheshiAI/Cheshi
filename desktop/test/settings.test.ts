import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import { createSettingsService } from '../lib/settings-service.mts';
import { registerSettingsIpc } from '../lib/settings-ipc.mts';
import { createSettingsApi } from '../lib/settings-preload.cts';
import { SETTINGS_CHANNELS, parseTypeSafeSettings } from '../shared/settings.ts';

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
  const options = { directory, encryption, fallback: () => 'environment-fixture-key', checkKey: async (_key: string) => {} };
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

test('keys persist encrypted, survive restart and only expose masked metadata', () => {
  const f = fixture();
  try {
    const saved = f.service.save(key);
    expect(saved).toEqual({ source: 'saved', maskedKey: '••••2345', canSave: true, error: null });
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
  let response: unknown = { source: 'saved', maskedKey: '••••2345', canSave: true, error: null };
  const ipc = { invoke: async (...values: unknown[]) => { calls.push(values); return response; },
    on() {}, removeListener() {} } as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;
  const api = createSettingsApi(ipc);
  expect((await api.saveTypeSafe(key)).maskedKey).toBe('••••2345');
  expect(calls[0]).toEqual([SETTINGS_CHANNELS.save, key]);
  await rejected(api.saveTypeSafe('invalid key'), 'valid');
  response = { source: 'saved', maskedKey: key, canSave: true, error: null };
  await rejected(api.getTypeSafe(), 'Invalid');
  response = 'true';
  await rejected(api.checkTypeSafe(), 'Invalid');
});
