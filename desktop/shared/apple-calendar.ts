export const CALENDAR_ERRORS = {
  unsupported: 'Apple 캘린더 연동은 macOS에서 사용할 수 있습니다.',
  permission: '시스템 설정 → 개인정보 보호 및 보안 → 캘린더에서 Cheshi의 전체 접근을 허용해 주세요.',
  unavailable: '캘린더에 연결하지 못했습니다. 앱을 다시 시작하고 연결 상태를 확인해 주세요.',
  'invalid-response': '캘린더에서 받은 데이터 형식을 처리하지 못했습니다. 다른 캘린더를 선택하거나 새로고침해 주세요.',
  invalid: '일정 정보를 확인해 주세요. 종료 시간은 시작 시간보다 뒤여야 합니다.',
  'not-found': '일정 또는 캘린더가 없어졌습니다. 새로고침해 주세요.',
  'read-only': '읽기 전용 캘린더, 반복 일정, 초대 일정은 Apple 캘린더에서 편집해 주세요.',
  conflict: 'Apple 캘린더에서 일정이 변경되었습니다. 초안을 확인한 뒤 닫고 새로고침해 주세요.',
  'too-many': '표시할 일정이 너무 많습니다. 캘린더를 하나 선택해 주세요.',
  'write-unknown': '저장 또는 삭제 결과를 확인하지 못했습니다. 창을 닫고 새로고침하여 원본을 확인해 주세요. 자동으로 재시도하지 않습니다.',
} as const;
export type CalendarErrorCode = keyof typeof CALENDAR_ERRORS;
export type CalendarReply<T> = { ok: true; value: T } | { ok: false; error: { code: CalendarErrorCode; message: string } };
export type CalendarAccess = 'not-determined' | 'full' | 'denied' | 'restricted' | 'write-only';
export interface AppleCalendar { id: string; title: string; source: string; writable: boolean; isDefault: boolean }
export interface CalendarEventInput {
  calendarId: string; title: string; start: string; end: string; allDay: boolean;
  timeZone: string; location: string; notes: string;
}
export interface CalendarEvent extends CalendarEventInput {
  id: string; revision: string; recurring: boolean; readOnly: boolean;
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
  const title = text(item.title, 1000, existing).trim() || '(제목 없음)';
  return { calendarId: text(item.calendarId), title, ...dates(item.start, item.end, allDay, existing),
    allDay, timeZone, location: text(item.location, 4000, true), notes: text(item.notes, 100_000, true) };
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
  return { ...eventFields(item, true), ...calendarTarget(item), recurring, readOnly: readOnly || recurring };
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
export const appleCalendars = (value: unknown) => array(value, value => {
  const item = record(value);
  return { id: text(item.id), title: text(item.title, 4096, true), source: text(item.source, 4096, true),
    writable: flag(item.writable), isDefault: flag(item.isDefault) };
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
