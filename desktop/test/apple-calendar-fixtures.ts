import type { AppleCalendarApi, CalendarEvent } from '../shared/apple-calendar';

export const calendarEventFixture: CalendarEvent = {
  id: 'event-1', revision: 'revision-1', calendarId: 'calendar-1', title: 'Meeting',
  start: '2026-09-22T00:00:00.000Z', end: '2026-09-22T01:00:00.000Z',
  allDay: false, timeZone: 'Asia/Seoul', location: '', notes: '', recurring: false, readOnly: false,
};
export function calendarApiFixture(overrides: Partial<AppleCalendarApi> = {}): AppleCalendarApi {
  return {
    available: true, status: async () => ({ ok: true, value: 'full' }), connect: async () => ({ ok: true, value: 'full' }),
    calendars: async () => ({ ok: true, value: [{ id: 'calendar-1', title: 'Work', source: 'iCloud', writable: true, isDefault: true }] }),
    events: async () => ({ ok: true, value: [calendarEventFixture] }),
    create: async event => ({ ok: true, value: { ...calendarEventFixture, ...event } }),
    update: async input => ({ ok: true, value: { ...calendarEventFixture, ...input.event } }),
    delete: async target => ({ ok: true, value: target }),
    ...overrides,
  };
}
export function createCalendarDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
