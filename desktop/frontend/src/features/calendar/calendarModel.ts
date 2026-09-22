import type { AppleCalendar, AppleCalendarApi, CalendarAccess, CalendarEvent, CalendarQuery } from '../../../../shared/apple-calendar';
import { CALENDAR_ERRORS } from '../../../../shared/apple-calendar';

export interface CalendarState {
  access: CalendarAccess | null; calendars: AppleCalendar[]; events: CalendarEvent[];
  loading: boolean; error: string;
}
export function createCalendarModel(api: AppleCalendarApi) {
  let state: CalendarState = { access: null, calendars: [], events: [], loading: false, error: '' };
  let generation = 0;
  const listeners = new Set<() => void>();
  const patch = (update: Partial<CalendarState>) => { state = { ...state, ...update }; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => { ++generation; },
    async refresh(query: CalendarQuery, connect = false) {
      const request = ++generation;
      patch({ loading: true, error: '', events: [] });
      try {
        const access = await (connect ? api.connect() : api.status());
        if (request !== generation) return;
        if (!access.ok) { patch({ error: access.error.message, access: null, calendars: [] }); return; }
        patch({ access: access.value });
        if (access.value !== 'full') { patch({ calendars: [], error: access.value === 'not-determined' ? '' : CALENDAR_ERRORS.permission }); return; }
        const calendars = await api.calendars();
        if (request !== generation) return;
        if (!calendars.ok) { patch({ error: calendars.error.message, calendars: [], ...(calendars.error.code === 'permission' ? { access: 'denied' as const } : {}) }); return; }
        patch({ calendars: calendars.value });
        const events = await api.events(query);
        if (request !== generation) return;
        if (events.ok) patch({ events: events.value });
        else patch({ error: events.error.message, ...(events.error.code === 'permission' ? { access: 'denied' as const } : {}) });
      } catch { if (request === generation) patch({ error: CALENDAR_ERRORS.unavailable }); }
      finally { if (request === generation) patch({ loading: false }); }
    },
  };
}
