import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SchedulerStore } from '../lib/scheduler/store.mts';
import { SchedulerEngine } from '../lib/scheduler/engine.mts';
import { createSchedulerTestClock } from './scheduler-test-clock';
import { calendarEventFixture } from './apple-calendar-fixtures';
import type { ScheduleInput } from '../shared/scheduler';

async function fixture(run: (value: ReturnType<typeof setup>) => Promise<void>) {
  const value = setup();
  try { await run(value); } finally { await value.engine.stop(); value.store.close(); }
}
function setup() {
  const clock = createSchedulerTestClock();
  const store = new SchedulerStore(new Database(':memory:'));
  const engine = new SchedulerEngine(store, clock.now, clock.schedule);
  let executions = 0;
  engine.register('/workspace', { attention: () => [], async cancel() {}, async run(_run, update) {
    executions++; update({ status: 'completed' });
  } });
  const input = (hours: number): ScheduleInput => ({ title: 'Report', prompt: 'Inspect', startAt: new Date(clock.now() + hours * 3_600_000).toISOString(),
    timeZone: 'Asia/Seoul', repeat: 'once', enabled: true, threadId: null, permissionMode: 'read-only', model: null, effort: 'medium' });
  engine.start();
  return { clock, store, engine, input, executions: () => executions };
}
test('idle scheduler has no wakeups; a long wait wakes exactly at reminder and execution deadlines', async () => {
  await fixture(async ({ clock, store, engine, input, executions }) => {
    expect(clock.timers.size).toBe(0);
    engine.setAuto(true); engine.save('/workspace', input(12)); await Promise.resolve();
    expect([...clock.timers.values()]).toEqual([clock.now() + 12 * 3_600_000 - 300_000]);
    await clock.advance(12 * 3_600_000 - 300_001); expect(store.runs()).toHaveLength(0);
    await clock.advance(1); expect(store.runs()[0]?.status).toBe('pending');
    await clock.advance(300_000);
    expect(executions()).toBe(1); expect(store.runs()[0]?.status).toBe('completed');
    expect(clock.timers.size).toBe(0);
  });
});
test('earlier definitions rearm the deadline; deleting the final task removes the wakeup', async () => {
  await fixture(async ({ clock, store, engine, input }) => {
    const later = engine.save('/workspace', input(12));
    const earlier = engine.save('/workspace', input(1)); await Promise.resolve();
    expect([...clock.timers.values()]).toEqual([clock.now() + 3_300_000]);
    store.remove('/workspace', earlier.id, earlier.revision); await Promise.resolve();
    expect([...clock.timers.values()]).toEqual([clock.now() + 42_900_000]);
    store.remove('/workspace', later.id, later.revision); await Promise.resolve();
    expect(clock.timers.size).toBe(0);
  });
});
test('cached Apple events wake at five minutes without rereading the provider and deletion cancels reminders', async () => {
  await fixture(async ({ clock, store, engine }) => {
    const start = clock.now();
    const event = { ...calendarEventFixture, start: new Date(start + 7_200_000).toISOString(), end: new Date(start + 10_800_000).toISOString() };
    engine.syncEvents([event], start, start + 86_400_000);
    await clock.advance(6_900_000);
    expect(store.runs()[0]).toMatchObject({ kind: 'event', status: 'pending' });
    engine.syncEvents([], start, start + 86_400_000); await Promise.resolve();
    expect(store.runs()[0]?.status).toBe('cancelled'); expect(clock.timers.size).toBe(0);
  });
});
test('suspension cancels the timer and resuming across the due time records a miss without executing', async () => {
  await fixture(async ({ clock, store, engine, input, executions }) => {
    engine.setAuto(true); engine.save('/workspace', input(1));
    await clock.advance(3_300_000); engine.suspend(); expect(clock.timers.size).toBe(0);
    clock.jump(300_001); engine.resume();
    expect(store.runs()[0]?.status).toBe('missed'); expect(executions()).toBe(0);
  });
});
test('database transactions publish only committed changes and unchanged values do not emit', () => {
  const store = new SchedulerStore(new Database(':memory:'));
  let changes = 0; const unsubscribe = store.subscribe(() => changes++);
  try {
    store.auto = false; expect(changes).toBe(0);
    expect(() => store.transaction(() => { store.auto = true; throw new Error('rollback'); })).toThrow('rollback');
    expect(store.auto).toBe(false); expect(changes).toBe(0);
    store.transaction(() => { store.auto = true; store.auto = true; }); expect(changes).toBe(1);
    unsubscribe(); store.auto = false; expect(changes).toBe(1);
  } finally { store.close(); }
});
