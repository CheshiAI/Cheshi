import type { AppleCalendar, AppleCalendarApi, CalendarAccess, CalendarEvent, CalendarQuery } from '../../../../shared/apple-calendar';
import { CALENDAR_ERRORS } from '../../../../shared/apple-calendar';
import { hiddenHolidayCalendarIds } from './calendarHolidays';

export interface CalendarState {
  access: CalendarAccess | null; calendars: AppleCalendar[]; events: CalendarEvent[];
  loading: boolean; loaded: boolean; error: string;
}
export function createCalendarModel(api: AppleCalendarApi) {
  let state: CalendarState = { access: null, calendars: [], events: [], loading: false, loaded: false, error: '' };
  let loadedQuery = '';
  let generation = 0;
  const listeners = new Set<() => void>();
  const patch = (update: Partial<CalendarState>) => { state = { ...state, ...update }; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => { ++generation; },
    async refresh(query: CalendarQuery, connect = false) {
      const request = ++generation;
      const queryKey = JSON.stringify([query.start, query.end, query.calendarId]);
      const retain = state.loaded && loadedQuery === queryKey;
      patch({ loading: true, error: '', ...(!retain ? { events: [], loaded: false } : {}) });
      try {
        const access = await (connect ? api.connect() : api.status());
        if (request !== generation) return;
        if (!access.ok) { patch({ error: access.error.message, access: null, calendars: [], events: [], loaded: false }); return; }
        patch({ access: access.value });
        if (access.value !== 'full') { patch({ calendars: [], events: [], loaded: false, error: access.value === 'not-determined' ? '' : CALENDAR_ERRORS.permission }); return; }
        const calendars = await api.calendars();
        if (request !== generation) return;
        if (!calendars.ok) { patch({ error: calendars.error.message, calendars: [], events: [], loaded: false, ...(calendars.error.code === 'permission' ? { access: 'denied' as const } : {}) }); return; }
        const hidden = hiddenHolidayCalendarIds(calendars.value);
        const visibleCalendars = calendars.value.filter(calendar => !hidden.has(calendar.id));
        const events = await api.events(hidden.has(query.calendarId) ? { ...query, calendarId: '' } : query);
        if (request !== generation) return;
        if (events.ok) {
          loadedQuery = queryKey;
          patch({ calendars: visibleCalendars, events: events.value.filter(event => !hidden.has(event.calendarId)), loaded: true });
        } else patch({ calendars: visibleCalendars, events: [], loaded: false, error: events.error.message, ...(events.error.code === 'permission' ? { access: 'denied' as const } : {}) });
      } catch { if (request === generation) patch({ error: CALENDAR_ERRORS.unavailable, events: [], loaded: false }); }
      finally { if (request === generation) patch({ loading: false }); }
    },
  };
}
