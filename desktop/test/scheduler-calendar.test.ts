import { expect, test } from 'bun:test';
import { createSchedulerCalendar } from '../lib/scheduler/calendar.mts';
import { AppleCalendarService } from '../lib/apple-calendar-service.mts';
import { onAppleCalendarChanged } from '../lib/apple-calendar-changes.mts';
import { calendarApiFixture, calendarEventFixture } from './apple-calendar-fixtures';
import { createSchedulerDeferred, createSchedulerTestClock } from './scheduler-test-clock';
import type { CalendarEvent, CalendarReply } from '../shared/apple-calendar';

test('calendar reads once, renews its range near expiry, and has no per-second or per-minute polling', async () => {
  const clock = createSchedulerTestClock(); let reads = 0; let synced = 0;
  const controller = createSchedulerCalendar({ now: clock.now, timer: clock.schedule,
    calendar: calendarApiFixture({ events: async () => { reads++; return { ok: true, value: [] }; } }),
    engine: { syncEvents() { synced++; } }, error() {} });
  try {
    await controller.refresh(); expect(reads).toBe(1); expect(synced).toBe(1);
    expect([...clock.timers.values()]).toEqual([clock.now() + 86_100_000]);
    await clock.advance(86_099_999); expect(reads).toBe(1);
    await clock.advance(1); expect(reads).toBe(2);
    await controller.refresh(); expect(reads).toBe(3);
  } finally { await controller.stop(); }
  expect(clock.timers.size).toBe(0);
});
test('changes arriving during a read coalesce and obsolete data is never published', async () => {
  const gate = createSchedulerDeferred<CalendarReply<CalendarEvent[]>>();
  let reads = 0; const synced: CalendarEvent[][] = [];
  const controller = createSchedulerCalendar({ timer: createSchedulerTestClock().schedule,
    calendar: calendarApiFixture({ events: async () => ++reads === 1 ? gate.promise : { ok: true, value: [] } }),
    engine: { syncEvents(events) { synced.push(events); } }, error() {} });
  const first = controller.refresh(); await Promise.resolve();
  const second = controller.refresh(); const third = controller.refresh();
  gate.resolve({ ok: true, value: [calendarEventFixture] });
  await Promise.all([first, second, third]);
  expect(reads).toBe(2); expect(synced).toEqual([[]]); await controller.stop();
});
test('suspension suppresses reads and shutdown discards an in-flight response', async () => {
  const gate = createSchedulerDeferred<CalendarReply<CalendarEvent[]>>();
  let reads = 0; let synced = 0;
  const controller = createSchedulerCalendar({ calendar: calendarApiFixture({ events: async () => { reads++; return gate.promise; } }),
    engine: { syncEvents() { synced++; } }, error() {} });
  controller.suspend(); await controller.refresh(); expect(reads).toBe(0);
  const pending = controller.resume(); await Promise.resolve(); expect(reads).toBe(1);
  const stopping = controller.stop(); gate.resolve({ ok: true, value: [calendarEventFixture] });
  await Promise.all([pending, stopping]); expect(synced).toBe(0);
});
test('permission removal clears cached reminders, errors are reported without a hot retry loop', async () => {
  const clock = createSchedulerTestClock(); const errors: string[] = []; let cleared = 0;
  const api = calendarApiFixture({ status: async () => ({ ok: true, value: 'denied' }) });
  const controller = createSchedulerCalendar({ calendar: api, timer: clock.schedule,
    engine: { syncEvents(events) { expect(events).toEqual([]); cleared++; } }, error: message => errors.push(message) });
  await controller.refresh(); expect(cleared).toBe(1); expect(clock.timers.size).toBe(0);
  api.status = async () => { throw new Error('Unavailable'); };
  await controller.refresh(); expect(errors.at(-1)).toBe('Unavailable'); expect(clock.timers.size).toBe(0);
  await controller.stop();
});
test('local connect and writes invalidate reminders, reads do not feed back into refresh', async () => {
  let changed = 0;
  const remove = onAppleCalendarChanged(() => changed++);
  const service = new AppleCalendarService({ platform: 'darwin', execute: async (command: unknown) => {
    const action = (command as { action: string }).action;
    return { ok: true, value: action === 'status' || action === 'connect' ? 'full' : action === 'events' ? [] : calendarEventFixture };
  } });
  try {
    await service.status(); await service.events({ start: calendarEventFixture.start, end: calendarEventFixture.end, calendarId: '' });
    expect(changed).toBe(0);
    await service.connect(); await service.create(calendarEventFixture); expect(changed).toBe(2);
    const uncertain = new AppleCalendarService({ platform: 'darwin', execute: async () => { throw new Error('Lost acknowledgement'); } });
    await uncertain.create(calendarEventFixture); expect(changed).toBe(3);
  } finally { remove(); }
});

test('calendar state is invalidated before every refresh, renewal and wake, including failed reads', async () => {
  const clock = createSchedulerTestClock(); const order: string[] = []; let fail = false;
  const controller = createSchedulerCalendar({ now: clock.now, timer: clock.schedule,
    calendar: calendarApiFixture({ async events() { order.push('read'); if (fail) throw new Error('Offline'); return { ok: true, value: [] }; } }),
    engine: { invalidateCalendar() { order.push('invalidate'); }, syncEvents() { order.push('sync'); } }, error() {} });
  try {
    await controller.refresh(); expect(order).toEqual(['invalidate', 'read', 'sync']); order.length = 0;
    await clock.advance(86_100_000); expect(order).toEqual(['invalidate', 'read', 'sync']); order.length = 0;
    controller.suspend(); fail = true; await controller.resume();
    expect(order).toEqual(['invalidate', 'invalidate', 'read']); expect(clock.timers.size).toBe(0);
  } finally { await controller.stop(); }
});
