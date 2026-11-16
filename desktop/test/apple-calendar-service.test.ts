import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { AppleCalendarService } from '../lib/apple-calendar-service.mts';
import { registerAppleCalendarIpc } from '../lib/apple-calendar-ipc.mts';
import { createAppleCalendarApi } from '../lib/apple-calendar-preload.cts';
import { calendarEventFixture as event, createCalendarDeferred } from './apple-calendar-fixtures';

test('every calendar IPC handler authenticates the sender before accessing EventKit', () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  let calls = 0;
  registerAppleCalendarIpc({ ipcMain: { handle: (name, fn) => { handlers.set(name, fn); } },
    service: new AppleCalendarService({ execute: async () => { ++calls; return {}; } }),
    assertSender: () => { throw new Error('Untrusted sender'); } });
  expect(handlers.size).toBe(7);
  for (const handler of handlers.values()) expect(() => handler({} as IpcMainInvokeEvent, {})).toThrow('Untrusted sender');
  expect(calls).toBe(0);
});

test('service rejects invalid input and unsupported systems without spawning a helper', async () => {
  let calls = 0;
  const execute = async () => { ++calls; return {}; };
  const service = new AppleCalendarService({ platform: 'darwin', execute });
  expect(await service.create({ ...event, allDay: 'true' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
  expect(await service.delete({ id: '', revision: 'r' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
  expect(await new AppleCalendarService({ platform: 'linux', execute }).status()).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  expect(calls).toBe(0);
});

test('preload and service round-trip CRUD commands and permission replies', async () => {
  const commands: unknown[] = [];
  let response: unknown = { ok: true, value: event };
  const service = new AppleCalendarService({ platform: 'darwin', execute: async command => { commands.push(command); return response; } });
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  registerAppleCalendarIpc({ ipcMain: { handle: (name, fn) => { handlers.set(name, fn); } }, service, assertSender() {} });
  const api = createAppleCalendarApi({ invoke: async (name, ...args: unknown[]) => handlers.get(name)?.({} as IpcMainInvokeEvent, ...args) }, 'darwin');
  expect((await api.create(event)).ok).toBe(true);
  expect((await api.update({ target: event, event })).ok).toBe(true);
  response = { ok: true, value: { id: event.id, revision: event.revision } };
  expect((await api.delete(event)).ok).toBe(true);
  expect(commands.map(value => (value as { action: string }).action)).toEqual(['create', 'update', 'delete']);
  response = { ok: false, error: { code: 'permission' } };
  expect(await api.calendars()).toMatchObject({ ok: false, error: { code: 'permission' } });
});

test('lost or malformed mutation acknowledgements are uncertain and never retried', async () => {
  for (const response of [null, { ok: 'true', value: event }, { ok: true, value: { ...event, id: 'wrong' } }]) {
    let calls = 0;
    const api = createAppleCalendarApi({ invoke: async () => { ++calls; return response; } }, 'darwin');
    expect(await api.delete(event)).toMatchObject({ ok: false, error: { code: 'write-unknown' } });
    expect(calls).toBe(1);
  }
  const service = new AppleCalendarService({ platform: 'darwin', execute: async () => { throw new Error('Lost pipe'); } });
  expect(await service.create(event)).toMatchObject({ ok: false, error: { code: 'write-unknown' } });
  expect(await service.events({ start: event.start, end: event.end, calendarId: '' })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
});

test('mutations from different windows execute sequentially', async () => {
  const pending = createCalendarDeferred<unknown>();
  let calls = 0;
  const service = new AppleCalendarService({ platform: 'darwin', execute: async () => ++calls === 1 ? pending.promise : { ok: false, error: { code: 'conflict' } } });
  const first = service.update({ target: event, event });
  const second = service.delete(event);
  await Promise.resolve();
  expect(calls).toBe(1);
  pending.resolve({ ok: true, value: event });
  expect((await first).ok).toBe(true);
  expect(await second).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(calls).toBe(2);
});

test('calendar service and transitive imports load under native Node strip-only TypeScript', () => {
  const result = spawnSync('node', ['--input-type=module', '-e', "await import('./desktop/lib/apple-calendar-service.mts'); await import('./desktop/lib/apple-calendar-ipc.mts')"], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

test('fixed-offset events round-trip through service and preload including an update', async () => {
  const original = { ...event, timeZone: 'GMT+0900' };
  const commands: unknown[] = [];
  const service = new AppleCalendarService({ platform: 'darwin', execute: async (command: unknown) => {
    commands.push(command);
    return { ok: true, value: commands.length === 1 ? [original] : original };
  } });
  const api = createAppleCalendarApi({ invoke: async (channel: string, input: unknown) =>
    channel === 'cheshi:calendar-events' ? service.events(input) : service.update(input) }, 'darwin');
  expect(await api.events({ start: event.start, end: event.end, calendarId: '' })).toEqual({ ok: true, value: [original] });
  expect(await api.update({ target: original, event: original })).toEqual({ ok: true, value: original });
  expect(commands[1]).toMatchObject({ action: 'update', event: { timeZone: 'GMT+0900', start: event.start, end: event.end } });
});

test('invalid response data is distinct from connection failure while uncertain writes stay protected', async () => {
  const malformed = { ok: true, value: [{ ...event, timeZone: 'invalid/zone' }] };
  const query = { start: event.start, end: event.end, calendarId: '' };
  const service = new AppleCalendarService({ platform: 'darwin', execute: async () => malformed });
  expect(await service.events(query)).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
  const api = createAppleCalendarApi({ invoke: async () => malformed }, 'darwin');
  expect(await api.events(query)).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
  expect(await api.create(event)).toMatchObject({ ok: false, error: { code: 'write-unknown' } });
  expect(await service.create(event)).toMatchObject({ ok: false, error: { code: 'write-unknown' } });
  const disconnected = createAppleCalendarApi({ invoke: async () => { throw new Error('IPC unavailable'); } }, 'darwin');
  expect(await disconnected.events(query)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
});

test('validation diagnostics identify date failures without logging private event data', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const query = { start: event.start, end: event.end, calendarId: '' };
  try {
    const invalidDates = new AppleCalendarService({ platform: 'darwin', execute: async () => ({ ok: true, value: [{
      ...event, title: 'private-title', notes: 'private-notes', allDay: true, start: '2026-09-24', end: '2026-09-24',
    }] }) });
    expect((await invalidDates.events(query)).ok).toBe(false);
    expect(warn).toHaveBeenLastCalledWith('[cheshi:calendar] Response rejected: Invalid calendar interval: same-day all-day event');
    const invalidZone = new AppleCalendarService({ platform: 'darwin', execute: async () => ({ ok: true, value: [{
      ...event, timeZone: 'private-zone-value',
    }] }) });
    expect((await invalidZone.events(query)).ok).toBe(false);
    expect(warn).toHaveBeenLastCalledWith('[cheshi:calendar] Response rejected: Unknown validation failure');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-');
  } finally { warn.mockRestore(); }
});
