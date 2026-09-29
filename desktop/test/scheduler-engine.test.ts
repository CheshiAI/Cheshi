import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSchedulerStore, type SchedulerStore } from '../lib/scheduler/store.mts';
import { SchedulerEngine, type SchedulerRunner } from '../lib/scheduler/engine.mts';
import { scheduleInput, type ScheduleInput, type ScheduleRun } from '../shared/scheduler.ts';
import { nextScheduleTime } from '../shared/scheduler-time.ts';
import type { CalendarEvent } from '../shared/apple-calendar.ts';

const directories: string[] = [];
const stores: SchedulerStore[] = [];
const base = Date.parse('2026-09-29T09:00:00Z');
const input = (patch: Partial<ScheduleInput> = {}): ScheduleInput => ({ title: 'Review', prompt: 'Review workspace changes',
  startAt: new Date(base + 300_000).toISOString(), timeZone: 'Asia/Seoul', repeat: 'once', enabled: true,
  threadId: null, permissionMode: 'read-only', model: null, effort: 'medium', ...patch });
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-scheduler-')); directories.push(directory);
  const store = await openSchedulerStore(path.join(directory, 'scheduler.sqlite')); stores.push(store);
  let time = base;
  const engine = new SchedulerEngine(store, () => time);
  const executions: ScheduleRun[] = [];
  const runner: SchedulerRunner = { async run(run, update) { executions.push(run); update({ status: 'completed', summary: 'done', profileId: 'account-b', threadId: 'shared-b', turnId: 'turn-b' }); },
    async cancel() {}, attention: () => [] };
  engine.register('/workspace', runner);
  const advance = (milliseconds: number) => {
    const until = time + milliseconds;
    while (time < until) { time = Math.min(until, time + 1000); engine.tick(); }
  };
  return { engine, store, executions, advance, jump: (milliseconds: number) => { time += milliseconds; engine.tick(); } };
}
async function failure(operation: () => unknown | Promise<unknown>, text: string) {
  let error: unknown; try { await operation(); } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect(String(error)).toContain(text);
}

describe('Cheshi scheduler', () => {
  test('manual approval waits until the due time, records account handoff, and executes only once', async () => {
    const { engine, store, executions, advance } = await setup();
    engine.save('/workspace', input({ threadId: 'shared-a' }));
    const run = store.runs()[0]!;
    expect(run.status).toBe('pending'); expect(executions).toHaveLength(0);
    await engine.act('/workspace', run.id, 'approve');
    advance(299_000); expect(executions).toHaveLength(0);
    advance(1000); expect(executions).toHaveLength(1);
    advance(10_000); expect(executions).toHaveLength(1);
    expect(store.runs()[0]).toMatchObject({ status: 'completed', profileId: 'account-b', threadId: 'shared-b', turnId: 'turn-b', mode: 'manual' });
    expect(store.runs()[0]?.snapshot?.threadId).toBe('shared-a');
  });
  test('dismissing or not answering a confirmation never grants approval', async () => {
    const { engine, store, executions, advance } = await setup();
    engine.save('/workspace', input());
    await engine.act('/workspace', store.runs()[0]!.id, 'dismiss');
    advance(300_000);
    expect(executions).toHaveLength(0); expect(store.runs()[0]?.status).toBe('skipped');
  });
  test('auto reminders can dismiss without cancelling execution; turning auto off revokes pending auto', async () => {
    const { engine, store, executions, advance } = await setup();
    engine.setAuto(true); engine.save('/workspace', input());
    await engine.act('/workspace', store.runs()[0]!.id, 'dismiss');
    advance(300_000); expect(executions).toHaveLength(1);
    engine.save('/workspace', input({ startAt: new Date(base + 600_000).toISOString() }));
    engine.setAuto(false); advance(300_000); expect(executions).toHaveLength(1);
    expect(store.runs()[0]?.status).toBe('skipped');
  });
  test('auto on does not retroactively approve an already displayed manual occurrence', async () => {
    const { engine, executions, advance } = await setup(); engine.save('/workspace', input());
    engine.setAuto(true); advance(300_000); expect(executions).toHaveLength(0);
  });
  test('sleep misses require an explicit late run, repeated clicks cannot duplicate a run', async () => {
    const { engine, store, executions, jump } = await setup(); engine.setAuto(true); engine.save('/workspace', input());
    jump(360_000); const run = store.runs()[0]!;
    expect(run.status).toBe('missed'); expect(executions).toHaveLength(0);
    await engine.act('/workspace', run.id, 'run-late');
    await failure(() => engine.act('/workspace', run.id, 'run-late'), 'confirmation period');
    expect(executions).toHaveLength(1);
  });
  test('even a short system sleep across the due time does not auto-execute on wake', async () => {
    const { engine, store, executions, advance, jump } = await setup();
    engine.setAuto(true); engine.save('/workspace', input()); advance(299_000);
    engine.suspend(); jump(2000); engine.resume();
    expect(store.runs()[0]?.status).toBe('missed'); expect(executions).toHaveLength(0);
  });
  test('restart preserves app-common definitions and marks interrupted runs unknown', async () => {
    const { engine, store } = await setup(); engine.save('/workspace', input());
    const run = store.runs()[0]!;
    store.putRun({ ...run, status: 'running', profileId: 'old-account', threadId: 'old-thread' });
    const restored = new SchedulerEngine(store, () => base + 10_000);
    expect(restored.snapshot('/workspace').schedules).toHaveLength(1);
    expect(restored.snapshot('/workspace').runs[0]).toMatchObject({ status: 'unknown', profileId: 'old-account', threadId: 'old-thread' });
    expect(restored.snapshot('/different-workspace').schedules).toHaveLength(0);
  });
  test('editing invalidates approval, rejects stale revisions, deletion retains history', async () => {
    const { engine, store } = await setup(); const schedule = engine.save('/workspace', input());
    await engine.act('/workspace', store.runs()[0]!.id, 'approve');
    const changed = engine.save('/workspace', input({ prompt: 'Different task' }), schedule);
    expect(store.runs().filter(run => run.status === 'cancelled')).toHaveLength(1);
    expect(store.runs().filter(run => run.status === 'pending')).toHaveLength(1);
    await failure(() => engine.save('/workspace', input(), schedule), 'changed');
    store.remove('/workspace', changed.id, changed.revision);
    expect(store.schedules()).toHaveLength(0); expect(store.runs()).toHaveLength(2);
    expect(store.runs().every(run => run.status === 'cancelled')).toBe(true);
  });
  test('Apple events remind only, deduplicate and cancel when moved; all-day events do not execute', async () => {
    const { engine, store, executions } = await setup();
    const event: CalendarEvent = { id: 'event', revision: 'r1', calendarId: 'home', title: 'Meeting', start: new Date(base + 300_000).toISOString(),
      end: new Date(base + 3_900_000).toISOString(), timeZone: 'Asia/Seoul', allDay: false, recurring: false, readOnly: false, location: '', notes: '' };
    engine.syncEvents([event, { ...event, id: 'all-day', allDay: true }], base, base + 360_000);
    engine.syncEvents([event], base, base + 360_000); expect(store.runs()).toHaveLength(1);
    await failure(() => engine.act('/workspace', store.runs()[0]!.id, 'approve'), 'does not apply');
    engine.syncEvents([], base, base + 360_000);
    expect(store.runs()[0]?.status).toBe('cancelled'); expect(executions).toHaveLength(0);
  });
  test('workspace-scoped actions cannot run another workspace task', async () => {
    const { engine, store } = await setup(); engine.save('/workspace', input());
    await failure(() => engine.act('/different', store.runs()[0]!.id, 'approve'), 'no longer available');
  });
});

describe('scheduler input and repeat times', () => {
  test('validates booleans and does not accept elevated permission names', async () => {
    await failure(() => scheduleInput({ ...input(), enabled: 'true' }), 'option');
    await failure(() => scheduleInput({ ...input(), permissionMode: 'full-access' }), 'permissions');
    await failure(() => scheduleInput({ ...input(), timeZone: 'Invalid/Zone' }), 'zone');
    await failure(() => scheduleInput({ ...input(), startAt: '2026-02-30T09:00:00Z' }), 'date');
  });
  test('daily and weekly repeats preserve wall time across daylight saving', () => {
    const daily = input({ startAt: '2026-03-07T14:00:00.000Z', timeZone: 'America/New_York', repeat: 'daily' });
    expect(nextScheduleTime(daily, Date.parse(daily.startAt))).toBe('2026-03-08T13:00:00.000Z');
    expect(nextScheduleTime({ ...daily, repeat: 'weekly' }, Date.parse(daily.startAt))).toBe('2026-03-14T13:00:00.000Z');
  });
  test('nonexistent local time is skipped, repeated hour executes once', () => {
    const spring = input({ startAt: '2026-03-07T07:30:00.000Z', timeZone: 'America/New_York', repeat: 'daily' });
    expect(nextScheduleTime(spring, Date.parse(spring.startAt))).toBe('2026-03-09T06:30:00.000Z');
    const fall = input({ startAt: '2026-10-31T05:30:00.000Z', timeZone: 'America/New_York', repeat: 'daily' });
    const next = nextScheduleTime(fall, Date.parse(fall.startAt));
    expect(next).toBe('2026-11-01T05:30:00.000Z');
    expect(nextScheduleTime(fall, Date.parse(next!))).toBe('2026-11-02T06:30:00.000Z');
  });
});
