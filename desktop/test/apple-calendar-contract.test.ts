import { expect, test } from 'bun:test';
import { appleCalendars, calendarDate, calendarEvent, calendarEventInput, calendarQuery, calendarReply } from '../shared/apple-calendar';
import { calendarEventFixture as event } from './apple-calendar-fixtures';

test('calendar input requires literal booleans and real dates, ordered times and valid time zones', () => {
  expect(calendarEventInput(event).timeZone).toBe('Asia/Seoul');
  for (const allDay of ['false', 0, null, undefined]) expect(() => calendarEventInput({ ...event, allDay })).toThrow();
  for (const start of ['2026-02-30', '2026-09-31', '2026-09-22T25:00:00Z', 'bad']) {
    expect(() => calendarDate(start, !start.includes('T'))).toThrow();
  }
  expect(() => calendarEventInput({ ...event, end: event.start })).toThrow();
  expect(() => calendarEventInput({ ...event, timeZone: 'invalid/zone' })).toThrow();
  expect(() => calendarEventInput({ ...event, title: '   ' })).toThrow();
  expect(() => calendarEvent({ ...event, recurring: 'false' })).toThrow();
  expect(calendarEvent({ ...event, title: '' }).title).toBe('(Untitled)');
  expect(calendarEvent({ ...event, title: '   ', end: event.start }).title).toBe('(Untitled)');
  expect(calendarEvent({ ...event, recurring: true, readOnly: false }).readOnly).toBe(true);
});

test('calendar replies never treat truthy flags as success or writable calendars', () => {
  expect(() => calendarReply({ ok: 'true', value: event }, calendarEvent)).toThrow();
  expect(() => appleCalendars([{ id: 'id', title: '', source: '', writable: 'true', isDefault: false }])).toThrow();
  expect(calendarReply({ ok: false, error: { code: 'permission', message: 'untrusted text' } }, calendarEvent)).toMatchObject({
    ok: false, error: { code: 'permission' },
  });
});

test('calendar reads are limited to a bounded date window', () => {
  expect(calendarQuery({ start: event.start, end: event.end, calendarId: '' }).calendarId).toBe('');
  expect(() => calendarQuery({ start: event.start, end: '2027-01-01T00:00:00Z', calendarId: '' })).toThrow();
  expect(calendarEventInput({ ...event, allDay: true, start: '2026-09-22', end: '2026-09-23' })).toMatchObject({ allDay: true });
});

test('calendar provenance survives parsing and rejects malformed metadata without guessing legacy values', () => {
  const calendar = { id: 'holiday', title: '대한민국 공휴일', source: 'Subscribed Calendars', writable: false, isDefault: false };
  expect(appleCalendars([calendar])).toEqual([calendar]);
  for (const kind of ['local', 'caldav', 'exchange', 'subscription', 'birthday', 'unknown']) {
    expect(appleCalendars([{ ...calendar, kind, isSubscribed: true }])[0]).toMatchObject({ kind, isSubscribed: true });
  }
  expect(appleCalendars([{ ...calendar, isSubscribed: false }])[0]?.isSubscribed).toBe(false);
  for (const isSubscribed of ['true', 1, null]) {
    expect(() => appleCalendars([{ ...calendar, isSubscribed }])).toThrow();
  }
  for (const kind of ['apple', '', 1, null]) expect(() => appleCalendars([{ ...calendar, kind }])).toThrow();
});

test('Apple fixed-offset zones survive event reads and edits without changing dates or zone identifiers', () => {
  for (const timeZone of ['GMT+0900', 'GMT-0330', 'GMT+0530', 'GMT+05:45', 'GMT+0000', 'GMT-1800', 'GMT+1800', 'Asia/Seoul']) {
    for (const allDay of [false, true]) {
      const original = { ...event, timeZone, allDay,
        ...(allDay ? { start: '2026-09-22', end: '2026-09-23' } : {}) };
      const read = calendarEvent(original);
      expect(read.timeZone).toBe(timeZone);
      expect(calendarEventInput(read)).toMatchObject({ timeZone, start: original.start, end: original.end, allDay });
    }
  }
  for (const timeZone of ['GMT+1801', 'GMT-1900', 'GMT+2400', 'GMT+0960', 'GMT+09:99', 'GMT+0900junk', 'GMT+0900\n', 'invalid/zone']) {
    expect(() => calendarEvent({ ...event, timeZone })).toThrow();
    expect(() => calendarEventInput({ ...event, timeZone })).toThrow();
  }
});
