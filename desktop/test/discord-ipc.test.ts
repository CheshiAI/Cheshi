import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { registerDiscordIpc } from '../lib/discord-ipc.mts';
import { createDiscordApi } from '../lib/discord-preload.cts';

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>();
  const renderer = new EventEmitter();
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {},
    send(channel: string, value: unknown) { renderer.emit(channel, {}, value); } });
  const window = Object.assign(new EventEmitter(), { webContents: owner, show() {}, focus() {} });
  const state = { enabled: false, notificationsEnabled: true, guildId: '', ownerId: '', deviceName: 'Mac', connected: false, hasToken: false,
    channels: 0, pending: 0, status: 'Disabled', token: 'should-not-cross-bridge' };
  const service = { get: () => state, save: () => state, test: () => state };
  const registration = registerDiscordIpc({ window: window as unknown as BrowserWindow,
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } },
    service: service as unknown as Parameters<typeof registerDiscordIpc>[0]['service'], setup: async () => 'thread' });
  const invoke = (value: unknown, channel = 'confirm') => handlers.get(`cheshi:discord:${channel}`)!({ sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent, value);
  const api = createDiscordApi(Object.assign(renderer, { invoke: async (channel: string, value: unknown) => handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent, value) }) as unknown as Parameters<typeof createDiscordApi>[0]);
  return { handlers, owner, window, registration, api, invoke, renderer };
}
test('Discord settings reject another window and subframes; bridge returns no secret fields', async () => {
  const { handlers, owner, registration, api } = fixture();
  try {
    for (const event of [{ sender: {}, senderFrame: owner.mainFrame }, { sender: owner, senderFrame: {} }]) {
      expect(() => handlers.get('cheshi:discord:get')!(event as IpcMainInvokeEvent, undefined)).toThrow('owner');
    }
    expect(await api.get()).not.toHaveProperty('token');
  } finally { registration.dispose(); }
  expect(handlers.size).toBe(0);
});

const preferences = { enabled: false, guildId: '111111111111111111', ownerId: '222222222222222222', deviceName: 'Studio' };

test('confirmation is owner-only, exact, single-use and refuses concurrent requests', async () => {
  const f = fixture();
  const changes: unknown[] = [];
  const unsubscribe = f.api.onConfirmation(value => changes.push(value));
  try {
    const decision = f.registration.confirm(preferences, new AbortController().signal);
    const request = await f.api.getConfirmation();
    expect(request).toMatchObject({ guildId: preferences.guildId, ownerId: preferences.ownerId, deviceName: 'Studio' });
    expect(request).not.toHaveProperty('enabled');
    expect(await f.registration.confirm(preferences, new AbortController().signal)).toBe(false);
    expect(() => f.invoke({ id: 'stale', accepted: true })).toThrow('expired');
    expect(() => f.invoke({ id: request!.id, accepted: 'true' })).toThrow('expired');
    for (const event of [{ sender: {}, senderFrame: f.owner.mainFrame }, { sender: f.owner, senderFrame: {} }]) {
      expect(() => f.handlers.get('cheshi:discord:confirm')!(event as IpcMainInvokeEvent, { id: request!.id, accepted: true })).toThrow('owner');
    }
    await f.api.respondConfirmation(request!.id, true);
    expect(await decision).toBe(true);
    expect(await f.api.getConfirmation()).toBeNull();
    expect(() => f.invoke({ id: request!.id, accepted: true })).toThrow('expired');
    expect(changes).toEqual([request, null]);
  } finally { unsubscribe(); f.registration.dispose(); }
  expect(f.renderer.listenerCount('cheshi:discord:confirmation-changed')).toBe(0);
});

test('cancel, setup abort, reload, crash and owner close resolve without approval', async () => {
  for (const reason of ['cancel', 'abort', 'reload', 'crash', 'closed', 'dispose']) {
    const f = fixture(), controller = new AbortController();
    try {
      const decision = f.registration.confirm(preferences, controller.signal);
      const request = await f.api.getConfirmation();
      if (reason === 'cancel') await f.api.respondConfirmation(request!.id, false);
      if (reason === 'abort') controller.abort();
      if (reason === 'reload') f.owner.emit('did-start-loading');
      if (reason === 'crash') f.owner.emit('render-process-gone');
      if (reason === 'closed') f.window.emit('closed');
      if (reason === 'dispose') f.registration.dispose();
      expect(await decision).toBe(false);
    } finally { f.registration.dispose(); }
    expect(f.handlers.size).toBe(0);
    expect(f.owner.listenerCount('did-start-loading')).toBe(0);
  }
});

test('an unavailable renderer cannot leave setup waiting for an unseen confirmation', async () => {
  const f = fixture();
  try {
    f.owner.send = () => { throw new Error('Renderer unavailable'); };
    expect(await f.registration.confirm(preferences, new AbortController().signal)).toBe(false);
    expect(await f.api.getConfirmation()).toBeNull();
  } finally { f.registration.dispose(); }
});
