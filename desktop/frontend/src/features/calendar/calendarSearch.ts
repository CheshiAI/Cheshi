import type { AppleCalendar, AppleCalendarApi, CalendarEvent, CalendarQuery } from '../../../../shared/apple-calendar';
import { CALENDAR_ERRORS } from '../../../../shared/apple-calendar';
import { dayDate } from './calendarDates';
import { hiddenHolidayCalendarIds } from './calendarHolidays';

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim();

export function searchCalendarEvents(events: readonly CalendarEvent[], query: string): CalendarEvent[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return events.filter(event => {
    const text = normalize([event.title, event.location, event.notes].join('\n'));
    return terms.every(term => text.includes(term));
  });
}

export function calendarSearchQueries(year: number, calendarId: string): CalendarQuery[] {
  // Two-month windows stay below the bridge's 63-day limit, including DST.
  return Array.from({ length: 6 }, (_, index) => ({
    start: new Date(year, index * 2, 1).toISOString(),
    end: new Date(year, index * 2 + 2, 1).toISOString(), calendarId,
  }));
}

interface SearchState { events: CalendarEvent[]; loading: boolean; error: string }
const emptyState = (): SearchState => ({ events: [], loading: false, error: '' });
const eventStart = (event: CalendarEvent) => event.allDay
  ? dayDate(event.start).setHours(0, 0, 0, 0) : Date.parse(event.start);

export function createCalendarSearchModel(api: AppleCalendarApi) {
  let state = emptyState();
  let generation = 0;
  const listeners = new Set<() => void>();
  const patch = (update: Partial<SearchState>) => { state = { ...state, ...update }; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear() { ++generation; patch(emptyState()); },
    async load(year: number, calendarId: string, calendars: AppleCalendar[]) {
      const request = ++generation;
      patch({ events: [], loading: true, error: '' });
      const hidden = hiddenHolidayCalendarIds(calendars);
      const visibleIds = new Set(calendars.filter(calendar => !hidden.has(calendar.id)).map(calendar => calendar.id));
      const entries = new Map<string, CalendarEvent>();
      try {
        for (const query of calendarSearchQueries(year, calendarId)) {
          const reply = await api.events(query);
          if (request !== generation) return;
          if (!reply.ok) { patch({ error: reply.error.message }); return; }
          for (const event of reply.value) {
            if (!visibleIds.has(event.calendarId) || (calendarId && event.calendarId !== calendarId)) continue;
            // Long events can appear in adjacent windows; recurring occurrences
            // share an identifier but retain their separate start dates.
            entries.set(JSON.stringify([event.id, event.start]), event);
          }
          if (entries.size > 10_000) { patch({ error: CALENDAR_ERRORS['too-many'] }); return; }
        }
        patch({ events: [...entries.values()].sort((a, b) => eventStart(a) - eventStart(b) || a.title.localeCompare(b.title)) });
      } catch { if (request === generation) patch({ error: CALENDAR_ERRORS.unavailable }); }
      finally { if (request === generation) patch({ loading: false }); }
    },
  };
}
