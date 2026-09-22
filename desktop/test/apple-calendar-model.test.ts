import { expect, test } from 'bun:test';
import { calendarFailure, type CalendarEvent, type CalendarReply } from '../shared/apple-calendar';
import { createCalendarDraft } from '../frontend/src/features/calendar/calendarDraft';
import { createCalendarModel } from '../frontend/src/features/calendar/calendarModel';
import { eventOnDay, monthDays, monthQuery } from '../frontend/src/features/calendar/calendarDates';
import { calendarApiFixture, calendarEventFixture as event, createCalendarDeferred } from './apple-calendar-fixtures';

test('browsing never requests access; denied access cannot fetch private events', async () => {
  let connects = 0;
  let reads = 0;
  const model = createCalendarModel(calendarApiFixture({ status: async () => ({ ok: true, value: 'denied' }),
    connect: async () => { ++connects; return { ok: true, value: 'full' }; },
    events: async () => { ++reads; return { ok: true, value: [event] }; } }));
  await model.refresh(monthQuery('2026-09-22', ''));
  expect(connects).toBe(0); expect(reads).toBe(0);
  expect(model.getSnapshot()).toMatchObject({ access: 'denied', loading: false, events: [] });
  await model.refresh(monthQuery('2026-09-22', ''), true);
  expect(connects).toBe(1); expect(reads).toBe(1);
});

test('late reads cannot replace another month, calendar, or a disposed view', async () => {
  const pending = createCalendarDeferred<CalendarReply<CalendarEvent[]>>();
  let reads = 0;
  const api = calendarApiFixture({ events: async () => ++reads === 1 ? pending.promise : { ok: true, value: [{ ...event, id: 'latest' }] } });
  const model = createCalendarModel(api);
  const old = model.refresh(monthQuery('2026-09-22', ''));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await model.refresh(monthQuery('2026-10-22', 'calendar-1'));
  pending.resolve({ ok: true, value: [event] });
  await old;
  expect(model.getSnapshot().events[0]?.id).toBe('latest');
  const next = createCalendarDeferred<CalendarReply<CalendarEvent[]>>();
  api.events = async () => next.promise;
  const abandoned = model.refresh(monthQuery('2026-11-22', ''));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  model.dispose();
  next.resolve({ ok: true, value: [event] });
  await abandoned;
  expect(model.getSnapshot().events).toEqual([]);
});

test('refresh clears stale private data after permission revocation', async () => {
  const api = calendarApiFixture();
  const model = createCalendarModel(api);
  await model.refresh(monthQuery('2026-09-22', ''));
  expect(model.getSnapshot().events).toHaveLength(1);
  api.status = async () => ({ ok: true, value: 'denied' });
  await model.refresh(monthQuery('2026-09-22', ''));
  expect(model.getSnapshot()).toMatchObject({ events: [], calendars: [], access: 'denied' });
});

test('monthly grid covers six weeks; timed midnight and exclusive all-day endings do not spill', () => {
  expect(monthDays('2026-02-12')).toHaveLength(42);
  expect(monthDays('2026-02-12')[0]).toBe('2026-02-01');
  const allDay = { ...event, allDay: true, start: '2026-09-22', end: '2026-09-24' };
  expect(eventOnDay(allDay, '2026-09-21')).toBe(false);
  expect(eventOnDay(allDay, '2026-09-22')).toBe(true);
  expect(eventOnDay(allDay, '2026-09-23')).toBe(true);
  expect(eventOnDay(allDay, '2026-09-24')).toBe(false);
  const timed = { ...event, start: new Date(2026, 8, 22, 23).toISOString(), end: new Date(2026, 8, 23, 0).toISOString() };
  expect(eventOnDay(timed, '2026-09-22')).toBe(true);
  expect(eventOnDay(timed, '2026-09-23')).toBe(false);
});

test('all-day form uses an inclusive last day and saves an exclusive end', async () => {
  const draft = createCalendarDraft(null, '2026-09-22', 'calendar-1');
  draft.edit({ title: 'Holiday' }); draft.toggleAllDay(true);
  let saved: unknown;
  expect(await draft.submit(calendarApiFixture({ create: async input => { saved = input; return { ok: true, value: { ...event, ...input } }; } }))).toBe(true);
  expect(saved).toMatchObject({ start: '2026-09-22', end: '2026-09-23', allDay: true });
  const existing = createCalendarDraft({ ...event, allDay: true, start: '2026-09-22', end: '2026-09-25' }, '', '');
  expect(existing.getSnapshot().form.end).toBe('2026-09-24');
});

test('saving notes preserves exact instants including seconds and the original time zone', async () => {
  const original = { ...event, start: '2026-09-22T00:00:35.123Z' };
  const draft = createCalendarDraft(original, '', '');
  draft.edit({ notes: 'updated' });
  let saved: unknown;
  await draft.submit(calendarApiFixture({ update: async input => { saved = input; return { ok: true, value: original }; } }));
  expect(saved).toMatchObject({ target: { id: event.id, revision: event.revision }, event: { start: original.start, end: event.end, timeZone: 'Asia/Seoul' } });
});

test('editing fixed-offset events preserves exact instants and exclusive all-day boundaries', async () => {
  for (const allDay of [false, true]) {
    const original = { ...event, allDay, timeZone: 'GMT+0900',
      ...(allDay ? { start: '2026-09-22', end: '2026-09-24' } : { start: '2026-09-22T00:00:35.123Z' }) };
    const draft = createCalendarDraft(original, '', '');
    draft.edit({ notes: 'updated' });
    let saved: unknown;
    expect(await draft.submit(calendarApiFixture({ update: async input => {
      saved = input.event; return { ok: true, value: original };
    } }))).toBe(true);
    expect(saved).toMatchObject({ timeZone: original.timeZone, start: original.start, end: original.end, allDay, notes: 'updated' });
  }
});

test('double submit, uncertain writes and conflicts cannot trigger duplicate mutations', async () => {
  const pending = createCalendarDeferred<CalendarReply<CalendarEvent>>();
  let calls = 0;
  const api = calendarApiFixture({ create: async () => { ++calls; return pending.promise; } });
  const draft = createCalendarDraft(null, '2026-09-22', 'calendar-1');
  draft.edit({ title: 'Meeting' });
  const first = draft.submit(api);
  expect(await draft.submit(api)).toBe(false);
  expect(calls).toBe(1);
  pending.resolve(calendarFailure('write-unknown'));
  expect(await first).toBe(false);
  expect(draft.getSnapshot()).toMatchObject({ blocked: true, dirty: true, busy: false });
  expect(await draft.submit(api)).toBe(false);
  for (const code of ['conflict', 'not-found', 'read-only'] as const) {
    const existing = createCalendarDraft(event, '', '');
    existing.edit({ notes: 'preserve draft' });
    expect(await existing.submit(calendarApiFixture({ update: async () => calendarFailure(code) }))).toBe(false);
    expect(existing.getSnapshot()).toMatchObject({ blocked: true, form: { notes: 'preserve draft' } });
  }
});

test('read-only events cannot be edited or deleted; invalid ranges never reach API', async () => {
  let calls = 0;
  const api = calendarApiFixture({ update: async () => { ++calls; return { ok: true, value: event }; },
    delete: async target => { ++calls; return { ok: true, value: target }; } });
  const readOnly = createCalendarDraft({ ...event, readOnly: true, recurring: true }, '', '');
  readOnly.edit({ title: 'no' });
  expect(await readOnly.submit(api)).toBe(false);
  expect(await readOnly.submit(api, true)).toBe(false);
  expect(readOnly.getSnapshot().form.title).toBe(event.title);
  const invalid = createCalendarDraft(event, '', '');
  invalid.edit({ end: '2026-01-01T00:00' });
  expect(await invalid.submit(api)).toBe(false);
  expect(calls).toBe(0);
});
