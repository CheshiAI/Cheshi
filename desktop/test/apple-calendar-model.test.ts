import { expect, test } from 'bun:test';
import { calendarFailure, calendarQuery, type AppleCalendar, type CalendarEvent, type CalendarEventInput, type CalendarQuery, type CalendarReply } from '../shared/apple-calendar';
import { createCalendarDraft } from '../frontend/src/features/calendar/calendarDraft';
import { createCalendarModel } from '../frontend/src/features/calendar/calendarModel';
import { hiddenHolidayCalendarIds } from '../frontend/src/features/calendar/calendarHolidays';
import { calendarSearchQueries, createCalendarSearchModel, searchCalendarEvents } from '../frontend/src/features/calendar/calendarSearch';
import { eventOnDay, monthDays, monthQuery } from '../frontend/src/features/calendar/calendarDates';
import { calendarApiFixture, calendarEventFixture as event, createCalendarDeferred } from './apple-calendar-fixtures';

const appleHolidays: AppleCalendar = { id: 'apple-holidays', title: '대한민국 공휴일', source: 'Subscribed Calendars',
  writable: false, isDefault: false, kind: 'subscription', isSubscribed: true };
const googleHolidays: AppleCalendar = { id: 'google-holidays', title: '대한민국의 휴일', source: 'Google@Python',
  writable: false, isDefault: false, kind: 'caldav', isSubscribed: false };

test('annual search windows cover the whole local year without gaps and respect the native query limit', () => {
  for (const year of [2024, 2026]) {
    const queries = calendarSearchQueries(year, 'work');
    expect(queries).toHaveLength(6);
    expect(queries[0]?.start).toBe(new Date(year, 0, 1).toISOString());
    expect(queries.at(-1)?.end).toBe(new Date(year + 1, 0, 1).toISOString());
    queries.forEach((query, index) => {
      expect(calendarQuery(query)).toEqual(query);
      if (index) expect(query.start).toBe(queries[index - 1]!.end);
    });
  }
});

test('event search matches normalized title, location and notes across terms and ignores blank queries', () => {
  const events = [{ ...event, title: 'ＢＵＤＧＥＴ review', location: 'Seoul', notes: '분기 계획' },
    { ...event, id: 'other', title: 'Private', notes: 'Review the budget' }];
  expect(searchCalendarEvents(events, ' budget  SEOUL 계획 ')).toEqual([events[0]!]);
  expect(searchCalendarEvents(events, 'review')).toEqual(events);
  expect(searchCalendarEvents(events, 'missing')).toEqual([]);
  expect(searchCalendarEvents(events, ' \n ')).toEqual([]);
});

test('annual search deduplicates overlapping windows but preserves recurring occurrences and Apple holidays', async () => {
  const api = calendarApiFixture();
  const reply = await api.calendars();
  if (!reply.ok) throw new Error('Invalid fixture');
  const originals = [event, { ...event, start: '2026-10-22T00:00:00.000Z', end: '2026-10-22T01:00:00.000Z' },
    { ...event, id: 'holiday', calendarId: appleHolidays.id }, { ...event, id: 'hidden', calendarId: googleHolidays.id }];
  const queries: CalendarQuery[] = [];
  api.events = async query => { queries.push(query); return { ok: true, value: originals }; };
  const model = createCalendarSearchModel(api);
  await model.load(2026, '', [...reply.value, appleHolidays, googleHolidays]);
  expect(queries).toHaveLength(6);
  expect(model.getSnapshot()).toMatchObject({ loading: false, error: '' });
  expect(model.getSnapshot().events).toHaveLength(3);
  expect(model.getSnapshot().events.filter(item => item.id === event.id)).toHaveLength(2);
  expect(model.getSnapshot().events.some(item => item.id === 'hidden')).toBe(false);
  expect(model.getSnapshot().events.at(-1)?.start).toBe('2026-10-22T00:00:00.000Z');
  await model.load(2026, appleHolidays.id, [...reply.value, appleHolidays, googleHolidays]);
  expect(queries.slice(6).every(query => query.calendarId === appleHolidays.id)).toBe(true);
  expect(model.getSnapshot().events.map(item => item.id)).toEqual(['holiday']);
  expect(originals).toHaveLength(4);
});

test('search cancellation and year changes stop subsequent windows and ignore late replies', async () => {
  const pending = createCalendarDeferred<CalendarReply<CalendarEvent[]>>();
  let reads = 0;
  const api = calendarApiFixture({ events: async () => ++reads === 1 ? pending.promise : { ok: true, value: [] } });
  const calendars = [{ ...appleHolidays, id: event.calendarId }];
  const model = createCalendarSearchModel(api);
  const old = model.load(2025, '', calendars);
  await model.load(2026, '', calendars);
  pending.resolve({ ok: true, value: [event] });
  await old;
  expect(reads).toBe(7);
  expect(model.getSnapshot()).toEqual({ events: [], loading: false, loaded: true, error: '' });
  const abandoned = createCalendarDeferred<CalendarReply<CalendarEvent[]>>();
  api.events = () => { ++reads; return abandoned.promise; };
  const loading = model.load(2027, '', calendars);
  model.clear();
  abandoned.resolve({ ok: true, value: [event] });
  await loading;
  expect(reads).toBe(8);
  expect(model.getSnapshot()).toEqual({ events: [], loading: false, loaded: false, error: '' });
});

test('failed search windows discard partial results and preserve an error instead of claiming no matches', async () => {
  let calls = 0;
  const api = calendarApiFixture({ events: async () => ++calls === 1 ? { ok: true, value: [event] } : calendarFailure('permission') });
  const model = createCalendarSearchModel(api);
  await model.load(2026, '', [{ ...appleHolidays, id: event.calendarId }]);
  expect(calls).toBe(2);
  expect(model.getSnapshot()).toMatchObject({ events: [], loading: false });
  expect(model.getSnapshot().error).toContain('Allow full access');
});

test('Korean holidays use the Apple subscription while ordinary events and unrelated calendars remain intact', async () => {
  const calendars: AppleCalendar[] = [appleHolidays, googleHolidays,
    { ...googleHolidays, id: 'google-holidays-2', source: 'Google@Development' },
    { ...googleHolidays, id: 'personal', writable: true },
    { ...googleHolidays, id: 'shared-work', title: 'Work' },
    { ...googleHolidays, id: 'other-country', title: 'US Holidays' },
    { ...googleHolidays, id: 'other-provider', source: 'Exchange', kind: 'exchange' },
    { ...appleHolidays, id: 'birthdays', title: 'Birthdays', kind: 'birthday', isSubscribed: false },
  ];
  const originals = calendars.map(calendar => ({ ...event, id: calendar.id, calendarId: calendar.id, title: '추석' }));
  const model = createCalendarModel(calendarApiFixture({
    calendars: async () => ({ ok: true, value: calendars }), events: async () => ({ ok: true, value: originals }),
  }));
  await model.refresh(monthQuery('2026-09-22', ''));
  const visible = ['apple-holidays', 'personal', 'shared-work', 'other-country', 'other-provider', 'birthdays'];
  expect(model.getSnapshot().calendars.map(calendar => calendar.id)).toEqual(visible);
  expect(model.getSnapshot().events.map(event => event.calendarId)).toEqual(visible);
  expect(originals).toHaveLength(8);
  expect(calendars).toHaveLength(8);
});

test('missing, ambiguous or incomplete Apple subscription metadata never hides holidays', () => {
  const uncertain: AppleCalendar[][] = [[], [{ ...appleHolidays, kind: undefined }],
    [{ ...appleHolidays, isSubscribed: undefined }], [{ ...appleHolidays, isSubscribed: false }],
    [{ ...appleHolidays, writable: true }], [{ ...appleHolidays, kind: 'caldav' }],
    [{ ...appleHolidays, title: 'Holiday planning' }], [appleHolidays, { ...appleHolidays, id: 'other-subscription' }]];
  for (const candidates of uncertain) expect(hiddenHolidayCalendarIds([...candidates, googleHolidays]).size).toBe(0);
  for (const calendar of [{ ...googleHolidays, kind: undefined }, { ...googleHolidays, source: 'Personal Google archive' }]) {
    expect(hiddenHolidayCalendarIds([appleHolidays, calendar]).size).toBe(0);
  }
});

test('a previously selected Google holiday calendar falls back to all calendars; disappearing Apple subscriptions restore Google', async () => {
  let calendars = [appleHolidays, googleHolidays];
  const queries: CalendarQuery[] = [];
  const events = calendars.map(calendar => ({ ...event, id: calendar.id, calendarId: calendar.id }));
  const model = createCalendarModel(calendarApiFixture({
    calendars: async () => ({ ok: true, value: calendars }),
    events: async query => { queries.push(query); return { ok: true, value: events }; },
  }));
  const query = monthQuery('2026-09-22', googleHolidays.id);
  await model.refresh(query);
  expect(queries[0]).toEqual({ ...query, calendarId: '' });
  expect(model.getSnapshot().events.map(event => event.calendarId)).toEqual([appleHolidays.id]);
  calendars = [googleHolidays];
  await model.refresh(query);
  expect(queries[1]).toEqual(query);
  expect(model.getSnapshot().calendars).toEqual([googleHolidays]);
  expect(model.getSnapshot().events.some(event => event.calendarId === googleHolidays.id)).toBe(true);
});

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

test('same-scope refresh retains the completed snapshot while new month and calendar scopes start empty', async () => {
  const api = calendarApiFixture();
  const model = createCalendarModel(api);
  const query = monthQuery('2026-09-22', '');
  await model.refresh(query);
  const snapshot = model.getSnapshot();
  const pending = createCalendarDeferred<CalendarReply<CalendarEvent[]>>();
  const requested = createCalendarDeferred<void>();
  api.events = () => { requested.resolve(); return pending.promise; };
  const refreshing = model.refresh({ ...query });
  expect(model.getSnapshot().events).toBe(snapshot.events);
  expect(model.getSnapshot()).toMatchObject({ loaded: true, loading: true });
  await requested.promise;
  expect(model.getSnapshot().calendars).toBe(snapshot.calendars);
  expect(model.getSnapshot().events).toBe(snapshot.events);
  pending.resolve({ ok: true, value: [{ ...event, title: 'Updated' }] });
  await refreshing;
  expect(model.getSnapshot().events[0]?.title).toBe('Updated');
  for (const next of [monthQuery('2026-10-22', ''), monthQuery('2026-10-22', 'calendar-1')]) {
    const changing = model.refresh(next);
    expect(model.getSnapshot()).toMatchObject({ events: [], loaded: false, loading: true });
    await changing;
  }
});

test('annual revalidation retains results across cancellation but clears them for a different year or calendar', async () => {
  const api = calendarApiFixture();
  const calendars = [{ ...appleHolidays, id: event.calendarId }];
  const model = createCalendarSearchModel(api);
  await model.load(2026, '', calendars);
  const snapshot = model.getSnapshot();
  const pending = createCalendarDeferred<CalendarReply<CalendarEvent[]>>();
  api.events = () => pending.promise;
  const abandoned = model.load(2026, '', calendars);
  expect(model.getSnapshot().events).toBe(snapshot.events);
  model.cancel();
  expect(model.getSnapshot()).toMatchObject({ loaded: true, loading: false });
  expect(model.getSnapshot().events).toBe(snapshot.events);
  pending.resolve({ ok: true, value: [{ ...event, title: 'Abandoned' }] });
  await abandoned;
  expect(model.getSnapshot().events).toBe(snapshot.events);
  for (const [year, calendarId] of [[2027, ''], [2027, event.calendarId]] as const) {
    const changing = model.load(year, calendarId, calendars);
    expect(model.getSnapshot()).toMatchObject({ events: [], loaded: false, loading: true });
    await changing;
  }
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

test('changing start resets new and existing timed events to one hour, including date boundaries', async () => {
  for (const original of [null, event]) {
    for (const [start, end] of [
      ['2026-09-30T21:00', '2026-09-30T22:00'],
      ['2026-09-30T23:30', '2026-10-01T00:30'],
      ['2026-12-31T23:30', '2027-01-01T00:30'],
      ['2024-02-28T23:30', '2024-02-29T00:30'],
    ] as const) {
      const draft = createCalendarDraft(original, '2026-09-30', 'calendar-1');
      draft.edit({ title: 'Meeting' });
      draft.editStart(start);
      expect(draft.getSnapshot()).toMatchObject({ dirty: true, form: { start, end } });
      const saved: CalendarEvent[] = [];
      const save = async (input: CalendarEventInput) => {
        const value = { ...event, ...input }; saved.push(value); return { ok: true as const, value };
      };
      expect(await draft.submit(calendarApiFixture({ create: save, update: input => save(input.event) }))).toBe(true);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      expect(Date.parse(saved[0]!.end) - Date.parse(saved[0]!.start)).toBe(3_600_000);
    }
  }
});

test('manual end edits are preserved until start changes again and are used on save', async () => {
  const draft = createCalendarDraft(event, '', '');
  draft.editStart('2026-09-30T21:00');
  draft.edit({ end: '2026-10-01T01:30', notes: 'Long meeting' });
  draft.editStart('2026-09-30T21:00');
  expect(draft.getSnapshot().form.end).toBe('2026-10-01T01:30');
  draft.editStart('2026-09-30T22:00');
  expect(draft.getSnapshot().form.end).toBe('2026-09-30T23:00');
  draft.edit({ end: '2026-10-01T02:00' });
  let saved: unknown;
  expect(await draft.submit(calendarApiFixture({ update: async input => {
    saved = input.event; return { ok: true, value: event };
  } }))).toBe(true);
  expect(saved).toMatchObject({ start: new Date('2026-09-30T22:00').toISOString(),
    end: new Date('2026-10-01T02:00').toISOString(), notes: 'Long meeting' });
});

test('automatic end does not restore old seconds when it matches the original end minute', async () => {
  const original = { ...event, start: new Date(2026, 8, 30, 8, 0, 35).toISOString(),
    end: new Date(2026, 8, 30, 10, 0, 45).toISOString() };
  const draft = createCalendarDraft(original, '', '');
  draft.editStart('2026-09-30T09:00');
  draft.edit({ notes: 'Keep the calculated interval' });
  let saved: unknown;
  expect(await draft.submit(calendarApiFixture({ update: async input => {
    saved = input.event; return { ok: true, value: original };
  } }))).toBe(true);
  expect(saved).toMatchObject({ start: new Date(2026, 8, 30, 9).toISOString(), end: new Date(2026, 8, 30, 10).toISOString() });
});

test('automatic end keeps an elapsed hour across daylight saving transitions', async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    for (const [start, end, startInstant, endInstant] of [
      ['2026-03-08T01:30', '2026-03-08T03:30', '2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z'],
      ['2026-11-01T01:30', '2026-11-01T01:30', '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    ] as const) {
      const draft = createCalendarDraft(null, '2026-01-01', 'calendar-1');
      draft.editStart(start);
      draft.edit({ title: 'DST meeting' });
      expect(draft.getSnapshot().form.end).toBe(end);
      let saved: unknown;
      expect(await draft.submit(calendarApiFixture({ create: async input => {
        saved = input; return { ok: true, value: { ...event, ...input } };
      } }))).toBe(true);
      expect(saved).toMatchObject({ start: startInstant, end: endInstant });
    }
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test('start edits preserve all-day last dates and mode changes clear calculated timed instants', async () => {
  const draft = createCalendarDraft(event, '', '');
  draft.editStart('2026-09-30T23:30');
  draft.toggleAllDay(true);
  draft.editStart('2026-09-29');
  expect(draft.getSnapshot().form).toMatchObject({ start: '2026-09-29', end: '2026-10-01', allDay: true });
  draft.toggleAllDay(false);
  let saved: unknown;
  expect(await draft.submit(calendarApiFixture({ update: async input => {
    saved = input.event; return { ok: true, value: event };
  } }))).toBe(true);
  expect(saved).toMatchObject({ start: new Date('2026-09-29T09:00').toISOString(),
    end: new Date('2026-10-01T10:00').toISOString(), allDay: false });
});

test('invalid start input and read-only start edits preserve the existing range', () => {
  for (const readOnly of [false, true]) {
    const draft = createCalendarDraft({ ...event, readOnly }, '', '');
    const form = draft.getSnapshot().form;
    draft.editStart(readOnly ? '2026-09-30T21:00' : 'invalid');
    expect(draft.getSnapshot().form).toEqual(form);
    expect(draft.getSnapshot().dirty).toBe(false);
  }
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
