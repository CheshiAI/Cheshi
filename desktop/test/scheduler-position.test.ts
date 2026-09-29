import { expect, test } from 'bun:test';
import type { IpcRenderer } from 'electron';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSchedulerStore } from '../lib/scheduler/store.mts';
import { SchedulerEngine } from '../lib/scheduler/engine.mts';
import { createSchedulerApi } from '../lib/scheduler-preload.cts';
import { schedulerNotificationPosition, SCHEDULER_CHANNEL } from '../shared/scheduler';

test('notification position upgrades the existing database and persists across workspaces and restarts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-scheduler-position-'));
  const filename = path.join(directory, 'scheduler.sqlite');
  const legacy = new Database(filename);
  legacy.exec('CREATE TABLE scheduler_settings (id INTEGER PRIMARY KEY CHECK(id=1), auto INTEGER NOT NULL); INSERT INTO scheduler_settings VALUES(1,1);');
  legacy.close();
  let store = await openSchedulerStore(filename);
  try {
    expect(store.notificationPosition).toBe('bottom-left');
    expect(store.auto).toBe(true);
    const engine = new SchedulerEngine(store);
    let updates = 0;
    const unsubscribe = engine.subscribe(() => updates++);
    store.notificationPosition = 'top-right';
    await Promise.resolve();
    expect(updates).toBe(1);
    expect(engine.snapshot('/workspace-a').notificationPosition).toBe('top-right');
    expect(engine.snapshot('/workspace-b').notificationPosition).toBe('top-right');
    store.notificationPosition = 'top-right';
    await Promise.resolve();
    expect(updates).toBe(1);
    unsubscribe(); await engine.stop();
    store.close(); store = await openSchedulerStore(filename);
    expect(store.notificationPosition).toBe('top-right');
    expect(store.auto).toBe(true);
    store.notificationPosition = 'bottom-right';
    store.close(); store = await openSchedulerStore(filename);
    expect(store.notificationPosition).toBe('bottom-right');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('position boundary accepts only supported literal values', () => {
  for (const position of ['bottom-left', 'top-right', 'bottom-right'] as const) expect(schedulerNotificationPosition(position)).toBe(position);
  for (const invalid of ['left', 'top-left', '', null, true, {}, 1]) {
    expect(() => schedulerNotificationPosition(invalid)).toThrow('Invalid scheduler notification position');
  }
});

test('preload sends notification position to the shared scheduler channel', async () => {
  const calls: unknown[][] = [];
  const ipc = { async invoke(...args: unknown[]) { calls.push(args); }, on() { return this; }, removeListener() { return this; } };
  await createSchedulerApi(ipc as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>).setNotificationPosition!('top-right');
  expect(calls).toEqual([[SCHEDULER_CHANNEL, 'notification-position', 'top-right', undefined]]);
});
