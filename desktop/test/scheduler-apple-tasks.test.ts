import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { calendarTask } from '../lib/scheduler/calendar-tasks.mts';
import { calendarOccurrenceKey, calendarTaskError, isCalendarTask } from '../shared/calendar-task';
import { openSchedulerStore } from '../lib/scheduler/store.mts';
import { SchedulerEngine } from '../lib/scheduler/engine.mts';
import { migrateSchedule } from '../lib/scheduler/migration.mts';
import { createSchedulerTestClock } from './scheduler-test-clock';
import { calendarApiFixture, calendarEventFixture } from './apple-calendar-fixtures';
import type { CalendarEvent } from '../shared/apple-calendar';
import type { ScheduleRun } from '../shared/scheduler';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'cheshi-apple-task-')));
  const store = await openSchedulerStore(path.join(directory, 'tasks.sqlite'));
  const clock = createSchedulerTestClock(Date.now());
  const engine = new SchedulerEngine(store, clock.now, clock.schedule);
  const executed: ScheduleRun[] = [];
  // No workspace window or renderer runner registration.
  engine.setRunnerFactory(() => ({ async run(run, update) { executed.push(run); update({ status: 'completed' }); }, async cancel() {}, attention: () => [] }));
  engine.start();
  cleanup.push(async () => { await engine.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const event: CalendarEvent = { ...calendarEventFixture, title: '[task] Review', notes: 'Inspect this workspace', url: pathToFileURL(directory).href,
    occurrenceId: 'stable-id', start: new Date(clock.now() + 300_000).toISOString(), end: new Date(clock.now() + 3_900_000).toISOString() };
  const sync = (events: CalendarEvent[]) => engine.syncEvents(events, clock.now() - 60_000, clock.now() + 86_400_000);
  return { directory, store, clock, engine, executed, event, sync };
}
async function rejects(action: () => unknown | Promise<unknown>, message: string) {
  let error: unknown; try { await action(); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error); expect(String(error)).toContain(message);
}

test('task prefix, notes and local URL map to one account-independent task', async () => {
  const f = await fixture();
  expect(isCalendarTask('  [TASK] Review')).toBe(true); expect(isCalendarTask('[tasks] Review')).toBe(false);
  expect(calendarTask(f.event)).toMatchObject({ workspace: f.directory, error: '', input: { title: 'Review', prompt: 'Inspect this workspace', threadId: null } });
  f.sync([f.event]); f.sync([f.event]);
  expect(f.store.runs()).toHaveLength(1); expect(f.store.runs()[0]?.kind).toBe('task');
  expect(f.store.schedules()).toHaveLength(0);
  await f.engine.act(f.directory, f.store.runs()[0]!.id, 'approve');
  await f.clock.advance(300_000);
  expect(f.executed).toHaveLength(1);
  f.sync([f.event]); await f.clock.advance(1000); expect(f.executed).toHaveLength(1);
});
test('invalid task metadata never becomes executable', async () => {
  const f = await fixture(); f.engine.setAuto(true);
  for (const patch of [{ notes: '' }, { allDay: true }, { url: 'https://example.com/workspace' }, { url: 'file://other-host/folder' },
    { url: 'file:///' }, { url: 'file:///missing-cheshi-folder' }, { url: f.event.url + '?command=run' }]) {
    const event = { ...f.event, ...patch };
    expect(calendarTask(event).input).toBeNull(); f.sync([event]); expect(f.store.runs()).toHaveLength(0);
  }
  expect(calendarTaskError({ ...f.event, url: 'file:///tmp/%00' })).not.toBe('');
});
test('edits clear approval, deletion or removing the prefix cancels pending execution', async () => {
  const f = await fixture(); f.sync([f.event]); const run = f.store.runs()[0]!;
  await f.engine.act(f.directory, run.id, 'approve');
  f.sync([{ ...f.event, notes: 'Changed instructions' }]);
  expect(f.store.run(run.id)).toMatchObject({ status: 'pending', approvedAt: null, snapshot: { prompt: 'Changed instructions' } });
  await f.engine.act(f.directory, run.id, 'approve');
  f.sync([{ ...f.event, title: 'Ordinary meeting' }]);
  expect(f.store.run(run.id)?.status).toBe('cancelled');
  f.sync([]); await f.clock.advance(300_000); expect(f.executed).toHaveLength(0);
});
test('moving a task to another workspace clears the previous workspace approval', async () => {
  const f = await fixture(); const other = await fixture(); f.sync([f.event]); const run = f.store.runs()[0]!;
  await f.engine.act(f.directory, run.id, 'approve');
  f.sync([{ ...f.event, url: pathToFileURL(other.directory).href }]);
  expect(f.store.run(run.id)).toMatchObject({ workspace: other.directory, status: 'pending', approvedAt: null });
  await rejects(() => f.engine.act(f.directory, run.id, 'approve'), 'no longer available');
});
test('a changed start replaces the pending occurrence without reusing approval', async () => {
  const f = await fixture(); f.sync([f.event]); await f.engine.act(f.directory, f.store.runs()[0]!.id, 'approve');
  const moved = { ...f.event, start: new Date(f.clock.now() + 600_000).toISOString() };
  f.sync([moved]); expect(f.store.runs()[0]?.status).toBe('cancelled');
  await f.clock.advance(300_000);
  expect(f.store.runs(['pending'])).toHaveLength(1); expect(f.executed).toHaveLength(0);
  await f.clock.advance(300_000); expect(f.executed).toHaveLength(0);
});
test('completed occurrences do not rerun after edits or restart; repeated occurrences remain distinct', async () => {
  const f = await fixture(); f.engine.setAuto(true); f.sync([f.event]); await f.clock.advance(300_000);
  const moved = { ...f.event, start: new Date(f.clock.now() + 300_000).toISOString() };
  f.sync([moved]); await f.clock.advance(300_000); expect(f.executed).toHaveLength(1);
  const next = { ...moved, recurring: true, occurrenceId: 'stable-id:next', start: new Date(f.clock.now() + 300_000).toISOString() };
  expect(calendarOccurrenceKey(next)).not.toBe(calendarOccurrenceKey(moved));
  f.sync([next]); await f.clock.advance(300_000); expect(f.executed).toHaveLength(2);
  await f.engine.stop();
  const restored = new SchedulerEngine(f.store, f.clock.now, f.clock.schedule);
  restored.syncEvents([next], f.clock.now() - 60_000, f.clock.now() + 86_400_000);
  expect(f.store.runs()).toHaveLength(2); await restored.stop();
});
test('unverified calendars and sleep across the deadline cannot auto execute', async () => {
  const f = await fixture(); f.engine.setAuto(true); f.sync([f.event]);
  f.engine.invalidateCalendar(); await rejects(() => f.engine.act(f.directory, f.store.runs()[0]!.id, 'approve'), 'refresh');
  await f.clock.advance(300_000); expect(f.store.runs()[0]?.status).toBe('missed'); expect(f.executed).toHaveLength(0);
  f.sync([f.event]); await f.engine.act(f.directory, f.store.runs()[0]!.id, 'run-late'); expect(f.executed).toHaveLength(1);
  const next = { ...f.event, occurrenceId: 'next', start: new Date(f.clock.now() + 300_000).toISOString() };
  f.sync([next]); f.engine.suspend(); f.clock.jump(300_100); f.engine.resume();
  expect(f.store.runs().find(run => run.scheduleId === calendarOccurrenceKey(next))?.status).toBe('missed');
  expect(f.executed).toHaveLength(1);
});
test('migration pauses the old task, retains history and preserves execution settings', async () => {
  const f = await fixture();
  const input = { ...calendarTask(f.event).input!, repeat: 'weekly' as const, threadId: 'shared-conversation', permissionMode: 'ask-for-approval' as const };
  const legacy = f.engine.save(f.directory, input);
  let created: CalendarEvent | undefined;
  await migrateSchedule(f.engine, calendarApiFixture({ async create(value) { created = { ...f.event, ...value, id: 'migrated' }; return { ok: true, value: created }; } }),
    f.directory, legacy.id, legacy.revision, f.event.calendarId);
  expect(created).toMatchObject({ title: '[task] Review', notes: input.prompt, url: f.event.url, repeat: 'weekly' });
  expect(f.store.schedules()[0]).toMatchObject({ enabled: false, calendarLink: { state: 'linked', eventId: 'migrated' } });
  expect(f.store.runs()[0]?.status).toBe('cancelled');
  f.sync([created!]); expect(f.store.runs(['pending'])[0]?.snapshot).toMatchObject({ threadId: 'shared-conversation', permissionMode: 'ask-for-approval' });
});
test('uncertain migration cannot retry or leave both task sources active', async () => {
  const f = await fixture(); const legacy = f.engine.save(f.directory, calendarTask(f.event).input!); let writes = 0;
  const api = calendarApiFixture({ async create() { writes++; throw new Error('Disconnected after saving'); } });
  await rejects(() => migrateSchedule(f.engine, api, f.directory, legacy.id, legacy.revision, f.event.calendarId), 'could not be confirmed');
  const paused = f.store.schedules()[0]!; expect(paused).toMatchObject({ enabled: false, calendarLink: { state: 'unknown' } });
  await rejects(() => migrateSchedule(f.engine, api, f.directory, paused.id, paused.revision, f.event.calendarId), 'already');
  await f.clock.advance(300_000); expect(f.executed).toHaveLength(0); expect(writes).toBe(1);
});
test('definite migration failure restores the schedule but not its old approval', async () => {
  const f = await fixture(); const legacy = f.engine.save(f.directory, calendarTask(f.event).input!);
  await f.engine.act(f.directory, f.store.runs()[0]!.id, 'approve');
  await rejects(() => migrateSchedule(f.engine, calendarApiFixture({ async create() { return { ok: false, error: { code: 'permission', message: 'Denied' } }; } }),
    f.directory, legacy.id, legacy.revision, f.event.calendarId), 'Denied');
  f.engine.tick(); expect(f.store.schedules()[0]?.enabled).toBe(true);
  expect(f.store.runs(['pending'])).toHaveLength(1); expect(f.store.runs(['approved'])).toHaveLength(0);
});

test('two connections can claim one occurrence only once; another live app cannot mark it interrupted', async () => {
  const f = await fixture(); f.sync([f.event]); const run = f.store.runs()[0]!;
  const second = await openSchedulerStore(path.join(f.directory, 'tasks.sqlite'));
  try {
    expect(f.store.claimRun(run, new Date().toISOString())).toBe(true);
    expect(second.claimRun(run, new Date().toISOString())).toBe(false);
    const other = new SchedulerEngine(second);
    expect(second.run(run.id)).toMatchObject({ status: 'starting', ownerPid: process.pid });
    await other.stop();
  } finally { second.close(); }
});

test('execution rejects stale approval or task content rather than claiming a changed run', async () => {
  const f = await fixture(); f.sync([f.event]); const run = f.store.runs()[0]!;
  f.sync([{ ...f.event, notes: 'New instructions' }]);
  expect(f.store.claimRun(run, new Date().toISOString())).toBe(false);
  expect(f.store.runs()[0]?.status).toBe('pending');
});
