import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, IpcRenderer } from 'electron';
import { HomiesActivation } from '../lib/homies-activation.mts';
import { createSettingsService } from '../lib/settings-service.mts';
import { registerSettingsIpc } from '../lib/settings-ipc.mts';
import { createSettingsApi } from '../lib/settings-preload.cts';
import { SETTINGS_CHANNELS } from '../shared/settings.ts';
import type { HomieSetupStatus } from '../shared/homie-setup.ts';
import { createAgentOrchestration } from '../lib/agent-orchestration/service.mts';
import { bindingFor } from '../lib/agent-orchestration/mailbox.mts';

const ready: HomieSetupStatus = { supported: true, brew: true, docker: true, colima: true, connected: true, busy: false, detail: 'Ready' };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function rejection(operation: Promise<unknown>): Promise<Error> {
  try { await operation; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error('Expected rejection.');
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-homies-'));
  const preferences = createSettingsService({ settingsPath: join(directory, 'settings.json') });
  let status = ready, idle = true;
  const gate = new HomiesActivation({ preferences, inspect: async () => status, assertIdle: async () => {
    if (!idle) throw new Error('Finish active work first.');
  } });
  return { directory, preferences, gate, status: (value: HomieSetupStatus) => { status = value; }, busy: () => { idle = false; },
    close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('Homies defaults off and only enables after every prerequisite is freshly verified', async () => {
  const f = fixture();
  try {
    expect(f.preferences.getHomiesEnabled()).toBe(false);
    expect(f.gate.getHomiesEnabled()).toBe(false);
    let calls = 0;
    expect((await rejection(f.gate.run(() => { calls++; }))).message).toContain('Enable Homies');
    await f.gate.background(async () => { calls++; });
    expect(calls).toBe(0);
    for (const key of ['supported', 'brew', 'docker', 'colima', 'connected', 'busy'] as const) {
      f.status({ ...ready, [key]: key === 'busy' });
      await rejection(f.gate.setHomiesEnabled(true));
      expect(f.preferences.getHomiesEnabled()).toBe(false);
    }
    f.status(ready);
    expect(await f.gate.setHomiesEnabled(true)).toBe(true);
    expect(f.preferences.getHomiesEnabled()).toBe(true);
    await f.gate.run(() => { calls++; });
    expect(calls).toBe(1);
    for (const invalid of ['true', 1, null, {}, undefined]) await rejection(f.gate.setHomiesEnabled(invalid));
  } finally { f.close(); }
});
test('OFF refuses in-flight operations, terminal holds and unresolved remote work without changing the saved setting', async () => {
  const f = fixture();
  try {
    await f.gate.setHomiesEnabled(true);
    const pending = createDeferred<void>();
    const operation = f.gate.run(() => pending.promise);
    expect((await rejection(f.gate.setHomiesEnabled(false))).message).toContain('active or unresolved');
    pending.resolve(); await operation;
    const release = f.gate.hold();
    await rejection(f.gate.setHomiesEnabled(false)); release(); release();
    f.busy(); await rejection(f.gate.setHomiesEnabled(false));
    expect(f.gate.available()).toBe(true);
    expect(f.preferences.getHomiesEnabled()).toBe(true);
  } finally { f.close(); }
});
test('OFF excludes new work throughout asynchronous preflight and a failed save retains ON', async () => {
  const pending = createDeferred<void>();
  let saved = false, fail = false;
  const gate = new HomiesActivation({ preferences: { getHomiesEnabled: () => saved, setHomiesEnabled: value => {
    if (fail) throw new Error('Disk failure'); saved = value; return saved;
  } }, inspect: async () => ready, assertIdle: () => pending.promise });
  await gate.setHomiesEnabled(true);
  const off = gate.setHomiesEnabled(false);
  await rejection(gate.run(() => {})); await rejection(gate.setHomiesEnabled(true));
  fail = true; pending.resolve(); await rejection(off);
  expect(gate.available()).toBe(true); expect(saved).toBe(true);
  fail = false; await gate.setHomiesEnabled(false);
  expect(saved).toBe(false);
});
test('restoring ON rechecks readiness and keeps execution off when the engine is unavailable', async () => {
  const f = fixture();
  try {
    f.preferences.setHomiesEnabled(true); f.status({ ...ready, connected: false });
    await f.gate.restore(); expect(f.gate.available()).toBe(false); expect(f.preferences.getHomiesEnabled()).toBe(false);
    f.preferences.setHomiesEnabled(true); f.status(ready);
    await f.gate.restore(); expect(f.gate.available()).toBe(true);
  } finally { f.close(); }
});
test('settings IPC broadcasts Homies changes to every owner window and removes subscriptions on close', async () => {
  const f = fixture();
  const windows = [0, 1].map(() => {
    const received: boolean[] = [], routes = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const owner = { mainFrame: {}, isDestroyed: () => false, send: (channel: string, value: boolean) => {
      if (channel === SETTINGS_CHANNELS.homiesEnabledChanged) received.push(value);
    } };
    const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
    const registration = registerSettingsIpc({ window, service: f.preferences, activation: f.gate,
      ipc: { handle: (channel, listener) => { routes.set(channel, listener); }, removeHandler: channel => { routes.delete(channel); } } });
    return { received, registration, invoke: (channel: string, value?: unknown) => routes.get(channel)!({ sender: owner, senderFrame: owner.mainFrame } as IpcMainInvokeEvent, value) };
  });
  try {
    await windows[0]!.invoke(SETTINGS_CHANNELS.setHomiesEnabled, true);
    expect(windows.map(w => w.received)).toEqual([[true], [true]]);
    expect(windows[1]!.invoke(SETTINGS_CHANNELS.getHomiesEnabled)).toBe(true);
    windows[0]!.registration.dispose();
    await windows[1]!.invoke(SETTINGS_CHANNELS.setHomiesEnabled, false);
    expect(windows.map(w => w.received)).toEqual([[true], [true, false]]);
  } finally { windows.forEach(w => w.registration.dispose()); f.close(); }
});
test('preload validates Homies replies, changes and unsubscribe behavior', async () => {
  const events = new EventEmitter(), calls: unknown[][] = [];
  let reply: unknown = false;
  const api = createSettingsApi(Object.assign(events, { invoke: async (...args: unknown[]) => { calls.push(args); return reply; } }) as unknown as IpcRenderer);
  const values: boolean[] = [], unsubscribe = api.onHomiesEnabledChanged(value => values.push(value));
  expect(await api.getHomiesEnabled()).toBe(false);
  reply = true; expect(await api.setHomiesEnabled(true)).toBe(true);
  expect(calls).toEqual([[SETTINGS_CHANNELS.getHomiesEnabled], [SETTINGS_CHANNELS.setHomiesEnabled, true]]);
  events.emit(SETTINGS_CHANNELS.homiesEnabledChanged, {}, true); unsubscribe(); events.emit(SETTINGS_CHANNELS.homiesEnabledChanged, {}, false);
  expect(values).toEqual([true]);
  reply = 'true'; await rejection(api.getHomiesEnabled());
});
test('OFF does not reconnect or exchange autonomous worker messages; ON resumes persisted bindings', async () => {
  const f = fixture();
  let connections = 0;
  const binding = bindingFor(f.directory, 'docker:colima', 'dev', 'account-dev');
  const service = createAgentOrchestration({ access: f.gate, filename: join(f.directory, 'mailbox.json'),
    peer: () => ({ id: 'dev', name: 'Dev', role: 'development', fileWrite: true, workProtocol: 1 }),
    connect: async () => { connections++; return null; } });
  try {
    service.register(binding); service.start(); await service.settled(); await service.tick();
    expect(connections).toBe(0);
    await f.gate.setHomiesEnabled(true); service.notify(); await service.settled();
    expect(connections).toBeGreaterThan(0);
    await f.gate.setHomiesEnabled(false); service.suspend(); const before = connections;
    service.notify(); await service.settled(); await service.tick(); expect(connections).toBe(before);
  } finally { await service.dispose(); f.close(); }
});
