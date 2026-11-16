import type { CalendarEvent, CalendarEventInput } from './apple-calendar.ts';

export const calendarOccurrenceKey = (event: CalendarEvent): string => `apple:${JSON.stringify([event.calendarId,
  event.occurrenceId ?? (event.recurring ? `${event.id}:${event.start}` : event.id)])}`;

export const isCalendarTask = (title: string): boolean => /^\[task\](?:\s|$)/i.test(title.trim());
export const calendarTaskTitle = (title: string): string => title.trim().replace(/^\[task\]\s*/i, '') || 'Untitled task';
export function calendarTaskError(event: CalendarEventInput): string {
  if (!isCalendarTask(event.title)) return '';
  if (event.allDay) return 'Set a start time for this task; all-day tasks cannot run.';
  if (!event.notes.trim()) return 'Add the task instructions in Notes.';
  try {
    const url = new URL(event.url ?? '');
    if (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost') && !url.search && !url.hash
      && url.pathname !== '/' && !decodeURIComponent(url.pathname).includes('\0')) return '';
  } catch { /* The same message covers missing and malformed workspace URLs. */ }
  return 'Set URL to the workspace folder, for example file:///Users/name/project.';
}
