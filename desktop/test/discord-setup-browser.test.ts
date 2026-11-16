import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { allowedDiscordSetupUrl, createDiscordSetupBrowser, discordSetupDestination } from '../lib/discord-setup-browser.mts';
import type { DiscordSettings } from '../shared/discord.ts';

function fixture(confirm?: Parameters<typeof createDiscordSetupBrowser>[0]['confirm']) {
  const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const settings: DiscordSettings = { enabled: false, notificationsEnabled: true, guildId: '', ownerId: '', deviceName: '', hasToken: false,
    connected: false, status: 'Not connected', channels: 0, pending: 0 };
  const saves: unknown[] = [], scripts: string[] = [], urls: string[] = [];
  let confirmed = false, destroyed = false, clipboard = '', currentUrl = '';
  const session = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  const contents = Object.assign(new EventEmitter(), { session, setWindowOpenHandler() {}, getURL: () => currentUrl,
    async executeJavaScriptInIsolatedWorld(_world: number, entries: Array<{ code: string }>) { scripts.push(entries[0]!.code); return { status: 'ready', controls: [] }; } });
  const view = Object.assign(new EventEmitter(), { webContents: contents, show() {}, hide() {}, setTitle() {}, isDestroyed: () => destroyed,
    destroy() { destroyed = true; view.emit('closed'); }, async loadURL(url: string) { currentUrl = url; urls.push(url); } });
  let configuration: unknown;
  const browser = createDiscordSetupBrowser({ parent: parent as unknown as BrowserWindow,
    createWindow: options => { configuration = options; destroyed = false; return view as unknown as BrowserWindow; },
    clipboard: { readText: () => clipboard, writeText: text => { clipboard = text; } },
    confirm: confirm ?? (async () => confirmed),
    settings: { get: () => ({ ...settings }), async save(value: unknown) { saves.push(value); Object.assign(settings, value); return { ...settings }; } } });
  return { browser, settings, saves, scripts, urls, contents, parent, configuration: () => configuration, confirmed: () => { confirmed = true; }, destroyed: () => destroyed };
}
test('only Discord setup URLs and minimal bot install permissions are allowed', () => {
  for (const url of ['file:///tmp/test', 'http://discord.com/login', 'https://discord.com.evil.test/login', 'https://discord.com/api/v10/users/@me', 'https://user:pass@discord.com/login']) expect(allowedDiscordSetupUrl(url)).toBe(false);
  expect(allowedDiscordSetupUrl('https://discord.com/developers/applications/123/bot')).toBe(true);
  const url = new URL(discordSetupDestination({ target: 'install', applicationId: '111111111111111111' }));
  expect(url.searchParams.get('scope')).toBe('bot'); expect(url.searchParams.get('permissions')).toBe('68624');
  expect(() => discordSetupDestination({ target: 'install', applicationId: '1&scope=identify' })).toThrow();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('closing setup aborts pending confirmation without saving', async () => {
  const started = createDeferred<AbortSignal>();
  const f = fixture((_preferences, signal) => {
    started.resolve(signal);
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  });
  const task = f.browser.execute({ action: 'configure', guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio' });
  const signal = await started.promise;
  f.browser.close();
  expect(signal.aborted).toBe(true);
  let error: unknown;
  try { await task; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('Setup has closed.');
  expect(f.saves).toEqual([]);
});

test('settings changed during confirmation cannot be overwritten by a stale approval', async () => {
  const started = createDeferred<void>(), decision = createDeferred<boolean>();
  const f = fixture(() => { started.resolve(); return decision.promise; });
  try {
    const task = f.browser.execute({ action: 'configure', guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio' });
    await started.promise;
    f.settings.deviceName = 'Changed elsewhere';
    decision.resolve(true);
    expect(await task).toEqual({ status: 'Settings changed. Inspect them before continuing.' });
    expect(f.saves).toEqual([]);
  } finally { f.browser.close(); }
});
test('settings changes require confirmation and never accept a token from tools', async () => {
  const f = fixture();
  const configure = { action: 'configure', guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio' };
  try {
    expect(await f.browser.execute(configure)).toEqual({ status: 'cancelled' }); expect(f.saves).toHaveLength(0);
    f.confirmed();
    await f.browser.execute(configure);
    expect(f.saves).toEqual([{ enabled: false, guildId: configure.guildId, ownerId: configure.ownerId, deviceName: 'Studio' }]);
    expect(await f.browser.execute({ action: 'connect' })).toMatchObject({ status: 'user-action-required' });
    let rejected = false;
    try { await f.browser.execute({ ...configure, token: 'do-not-accept' }); } catch { rejected = true; }
    expect(rejected).toBe(true); expect(f.saves).toHaveLength(1);
    f.settings.hasToken = true;
    await f.browser.execute({ action: 'connect' }); expect(f.settings.enabled).toBe(true);
    expect(f.saves.every(value => !Object.hasOwn(value as object, 'token'))).toBe(true);
  } finally { f.browser.close(); }
});
test('dedicated window is sandboxed, blocks navigation escape, and closes with its owner', async () => {
  const f = fixture();
  await f.browser.execute({ action: 'inspect' });
  expect(f.configuration()).toMatchObject({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
  expect(f.urls).toEqual(['https://discord.com/developers/applications']);
  let blocked = false;
  f.contents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://example.com');
  expect(blocked).toBe(true);
  f.parent.emit('closed'); expect(f.destroyed()).toBe(true);
  let rejected = false;
  try { await f.browser.execute({ action: 'inspect' }); } catch { rejected = true; }
  expect(rejected).toBe(true);
});
test('missing server ID gives recovery guidance without opening or navigating a window', async () => {
  const f = fixture();
  try {
    expect(await f.browser.execute({ action: 'navigate', target: 'server' })).toMatchObject({ status: 'invalid-argument' });
    expect(f.urls).toEqual([]);
    await f.browser.execute({ action: 'navigate', target: 'server', guildId: '111111111111111111' });
    expect(f.urls.at(-1)).toBe('https://discord.com/channels/111111111111111111');
    await f.browser.execute({ action: 'context_menu', ref: 'snapshot:1' });
    expect(f.scripts.at(-1)).toContain('"action":"context_menu"');
  } finally { f.browser.close(); }
});
