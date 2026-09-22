import type { CalendarEvent, CalendarQuery } from '../../../../shared/apple-calendar';

const pad = (value: number) => String(value).padStart(2, '0');
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function dayDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!, 12);
}
export function addDays(value: string, days: number): string {
  const date = dayDate(value);
  date.setDate(date.getDate() + days);
  return localDay(date);
}
export function monthDays(month: string): string[] {
  const first = dayDate(`${month.slice(0, 7)}-01`);
  const start = addDays(localDay(first), -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
export function monthQuery(month: string, calendarId: string): CalendarQuery {
  const days = monthDays(month);
  const start = dayDate(days[0]!);
  const end = dayDate(addDays(days[41]!, 1));
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), calendarId };
}
export function eventOnDay(event: CalendarEvent, day: string): boolean {
  if (event.allDay) return event.start <= day && event.end > day;
  const start = dayDate(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (event.start === event.end) return Date.parse(event.start) >= start.getTime() && Date.parse(event.start) < end.getTime();
  return Date.parse(event.start) < end.getTime() && Date.parse(event.end) > start.getTime();
}
export function localDateTime(value: string): string {
  const date = new Date(value);
  return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function dateTimeInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date.toISOString()) !== value) throw new Error('유효한 날짜와 시간을 입력해 주세요.');
  return date.toISOString();
}
