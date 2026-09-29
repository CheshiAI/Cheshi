export const CALENDAR_ERRORS = {
  unsupported: 'Apple Calendar integration is available on macOS.',
  permission: 'Allow full access for Cheshi in System Settings → Privacy & Security → Calendars.',
  unavailable: 'Could not connect to Apple Calendar. Restart the app and check the connection.',
  'invalid-response': 'Could not read the calendar data. Select another calendar or refresh.',
  invalid: 'Check the event details. The end must be after the start.',
  'not-found': 'This event or calendar is no longer available. Refresh to update the list.',
  'read-only': 'Edit read-only calendars, recurring events and invitations in Apple Calendar.',
  conflict: 'This event changed in Apple Calendar. Review your draft, then close and refresh.',
  'too-many': 'There are too many events to display. Select a single calendar.',
  'write-unknown': 'The save or deletion could not be confirmed. Close and refresh to check the original. No automatic retry will be attempted.',
} as const;
export type CalendarErrorCode = keyof typeof CALENDAR_ERRORS;
export type CalendarReply<T> = { ok: true; value: T } | { ok: false; error: { code: CalendarErrorCode; message: string } };
export type CalendarAccess = 'not-determined' | 'full' | 'denied' | 'restricted' | 'write-only';
export type CalendarKind = 'local' | 'caldav' | 'exchange' | 'subscription' | 'birthday' | 'unknown';
export interface AppleCalendar {
  id: string; title: string; source: string; writable: boolean; isDefault: boolean;
  kind?: CalendarKind; isSubscribed?: boolean;
}
export interface CalendarEventInput {
  calendarId: string; title: string; start: string; end: string; allDay: boolean;
  timeZone: string; location: string; notes: string; url?: string; repeat?: 'once' | 'daily' | 'weekly';
}
export interface CalendarEvent extends CalendarEventInput {
  id: string; revision: string; recurring: boolean; readOnly: boolean; occurrenceId?: string;
}
export interface CalendarQuery { start: string; end: string; calendarId: string }
export interface CalendarTarget { id: string; revision: string }
export interface CalendarUpdate { target: CalendarTarget; event: CalendarEventInput }
export interface AppleCalendarApi {
  available: boolean;
  status(): Promise<CalendarReply<CalendarAccess>>;
  connect(): Promise<CalendarReply<CalendarAccess>>;
  calendars(): Promise<CalendarReply<AppleCalendar[]>>;
  events(query: CalendarQuery): Promise<CalendarReply<CalendarEvent[]>>;
  create(event: CalendarEventInput): Promise<CalendarReply<CalendarEvent>>;
  update(input: CalendarUpdate): Promise<CalendarReply<CalendarEvent>>;
  delete(target: CalendarTarget): Promise<CalendarReply<CalendarTarget>>;
}
export function calendarFailure<T>(code: CalendarErrorCode): CalendarReply<T> {
  return { ok: false, error: { code, message: CALENDAR_ERRORS[code] } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid calendar object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) throw new TypeError('Invalid calendar text');
  return value;
}
function flag(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid calendar flag');
  return value;
}
export function calendarDate(value: unknown, allDay: boolean): string {
  const date = text(value, 40);
  const valid = allDay ? /^\d{4}-\d{2}-\d{2}$/.test(date) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(date);
  const parsed = new Date(date);
  if (!valid || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date.slice(0, 10)) throw new TypeError('Invalid calendar date');
  return date;
}
function dates(start: unknown, end: unknown, allDay: boolean, allowInstant = false) {
  const result = { start: calendarDate(start, allDay), end: calendarDate(end, allDay) };
  const duration = Date.parse(result.end) - Date.parse(result.start);
  if (duration < 0) throw new TypeError('Invalid calendar interval: end before start');
  if (duration === 0 && (!allowInstant || allDay)) throw new TypeError(allDay
    ? 'Invalid calendar interval: same-day all-day event' : 'Invalid calendar interval: zero duration');
  return result;
}
function calendarTimeZone(value: unknown): string {
  const timeZone = text(value, 200);
  // Foundation emits fixed offsets that Intl does not recognize. Keep the
  // native identifier unchanged for edits, including all-day date conversion.
  if (/^GMT[+-]/.test(timeZone)) {
    const offset = /^GMT[+-](\d{2}):?(\d{2})$/.exec(timeZone);
    if (!offset || offset[0] !== timeZone || Number(offset[2]) > 59 || Number(offset[1]) * 60 + Number(offset[2]) > 18 * 60) {
      throw new TypeError('Invalid calendar time zone');
    }
  } else {
    new Intl.DateTimeFormat('en', { timeZone }).format();
  }
  return timeZone;
}
function eventFields(value: unknown, existing: boolean): CalendarEventInput {
  const item = record(value);
  const allDay = flag(item.allDay);
  const timeZone = calendarTimeZone(item.timeZone);
  const title = text(item.title, 1000, existing).trim() || '(Untitled)';
  if (item.repeat !== undefined && !['once', 'daily', 'weekly'].includes(String(item.repeat))) throw new TypeError('Invalid calendar repeat');
  return { calendarId: text(item.calendarId), title, ...dates(item.start, item.end, allDay, existing),
    allDay, timeZone, location: text(item.location, 4000, true), notes: text(item.notes, 100_000, true),
    ...(item.url === undefined ? {} : { url: text(item.url, 16_384, true) }),
    ...(item.repeat === undefined ? {} : { repeat: item.repeat as 'once' | 'daily' | 'weekly' }) };
}
export const calendarEventInput = (value: unknown): CalendarEventInput => eventFields(value, false);
export function calendarTarget(value: unknown): CalendarTarget {
  const item = record(value);
  return { id: text(item.id), revision: text(item.revision, 200) };
}
export function calendarUpdate(value: unknown): CalendarUpdate {
  const item = record(value);
  return { target: calendarTarget(item.target), event: calendarEventInput(item.event) };
}
export function calendarEvent(value: unknown): CalendarEvent {
  const item = record(value);
  // Existing events may have no title or duration; keep them viewable.
  const recurring = flag(item.recurring);
  const readOnly = flag(item.readOnly);
  return { ...eventFields(item, true), ...calendarTarget(item), recurring, readOnly: readOnly || recurring,
    ...(item.occurrenceId === undefined ? {} : { occurrenceId: text(item.occurrenceId, 8192) }) };
}
export function calendarQuery(value: unknown): CalendarQuery {
  const item = record(value);
  const interval = dates(item.start, item.end, false);
  if (Date.parse(interval.end) - Date.parse(interval.start) > 63 * 86400_000) throw new TypeError('Calendar range too large');
  return { ...interval, calendarId: text(item.calendarId, 4096, true) };
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new TypeError('Invalid calendar list');
  return value.map(parse);
}
export const calendarEvents = (value: unknown) => array(value, calendarEvent);
function calendarKind(value: unknown): CalendarKind {
  if (value !== 'local' && value !== 'caldav' && value !== 'exchange' && value !== 'subscription' && value !== 'birthday' && value !== 'unknown') {
    throw new TypeError('Invalid calendar kind');
  }
  return value;
}
export const appleCalendars = (value: unknown) => array(value, value => {
  const item = record(value);
  return { id: text(item.id), title: text(item.title, 4096, true), source: text(item.source, 4096, true),
    writable: flag(item.writable), isDefault: flag(item.isDefault),
    // Older helpers do not report provenance; leave it unknown rather than guessing.
    ...(item.kind === undefined ? {} : { kind: calendarKind(item.kind) }),
    ...(item.isSubscribed === undefined ? {} : { isSubscribed: flag(item.isSubscribed) }) };
});
export function calendarAccess(value: unknown): CalendarAccess {
  if (value !== 'not-determined' && value !== 'full' && value !== 'denied' && value !== 'restricted' && value !== 'write-only') throw new TypeError('Invalid calendar access');
  return value;
}
export function calendarReply<T>(value: unknown, parse: (value: unknown) => T): CalendarReply<T> {
  const reply = record(value);
  if (reply.ok === true) return { ok: true, value: parse(reply.value) };
  const error = record(reply.error);
  if (reply.ok !== false || typeof error.code !== 'string' || !Object.hasOwn(CALENDAR_ERRORS, error.code)) throw new TypeError('Invalid calendar reply');
  return calendarFailure(error.code as CalendarErrorCode);
}
