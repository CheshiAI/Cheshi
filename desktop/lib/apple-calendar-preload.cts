import type { IpcRenderer } from 'electron';
import {
  appleCalendars, calendarAccess, calendarEvent, calendarEventInput, calendarEvents, calendarFailure,
  calendarQuery, calendarReply, calendarTarget, calendarUpdate,
} from '../shared/apple-calendar.ts';
import type { AppleCalendarApi, CalendarReply } from '../shared/apple-calendar.ts';

export function createAppleCalendarApi(ipc: Pick<IpcRenderer, 'invoke'>, platform: string): AppleCalendarApi {
  const invoke = async <T,>(action: string, parse: (value: unknown) => T, input?: unknown, mutation = false): Promise<CalendarReply<T>> => {
    let response: unknown;
    try { response = await ipc.invoke(`cheshi:calendar-${action}`, input); }
    catch { return calendarFailure(mutation ? 'write-unknown' : 'unavailable'); }
    try { return calendarReply(response, parse); }
    catch { return calendarFailure(mutation ? 'write-unknown' : 'invalid-response'); }
  };
  return {
    available: platform === 'darwin',
    status: () => invoke('status', calendarAccess),
    connect: () => invoke('connect', calendarAccess),
    calendars: () => invoke('calendars', appleCalendars),
    events: async query => invoke('events', calendarEvents, calendarQuery(query)),
    create: async input => invoke('create', calendarEvent, calendarEventInput(input), true),
    update: async input => {
      const request = calendarUpdate(input);
      return invoke('update', value => {
        const event = calendarEvent(value);
        if (event.id !== request.target.id) throw new TypeError('Unexpected calendar event');
        return event;
      }, request, true);
    },
    delete: async input => {
      const target = calendarTarget(input);
      return invoke('delete', value => {
        const deleted = calendarTarget(value);
        if (deleted.id !== target.id || deleted.revision !== target.revision) throw new TypeError('Unexpected calendar target');
        return deleted;
      }, target, true);
    },
  };
}
