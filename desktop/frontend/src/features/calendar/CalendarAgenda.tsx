import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AppleCalendarApi, CalendarEvent } from '../../../../shared/apple-calendar';
import { LiquidGlassPanel, NeumorphicTextField, NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { dayDate, eventOnDay } from './calendarDates';
import type { CalendarState } from './calendarModel';
import { createCalendarSearchModel, searchCalendarEvents } from './calendarSearch';
import { CalendarEventList, calendarRunHistory } from './CalendarEventList';
import styles from './Calendar.module.css';
import type { SchedulerSnapshot } from '../../../../shared/scheduler';

interface Props {
  api: AppleCalendarApi; state: CalendarState; calendarId: string; day: string;
  message: string; onOpen: (event: CalendarEvent) => void;
  options: ReactNode; panel?: ReactNode;
  scheduler?: SchedulerSnapshot;
}

export function CalendarAgenda({ api, state, calendarId, day, message, onOpen, options, panel, scheduler }: Props) {
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const [year, setYear] = useState(() => Number(day.slice(0, 4)));
  const [model] = useState(() => createCalendarSearchModel(api));
  const search = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (!searching) setYear(Number(day.slice(0, 4))); }, [day, searching]);
  useEffect(() => {
    if (searching && !state.loading && !state.error && state.access === 'full') {
      void model.load(year, calendarId, state.calendars);
    } else model.clear();
    return () => model.clear();
  }, [model, searching, year, calendarId, state.calendars, state.loading, state.error, state.access, retry]);
  const results = useMemo(() => searchCalendarEvents(search.events, query), [search.events, query]);
  const loading = state.loading || (searching && search.loading);
  const error = state.error || (searching ? search.error : '');
  const events = loading || error ? [] : searching ? results : state.events.filter(event => eventOnDay(event, day));
  const historyCount = calendarRunHistory(scheduler, events, searching, day, query, year, calendarId).length;
  if (panel) return <LiquidGlassPanel as="section" className={styles.agenda} aria-label="Calendar access">{options}{panel}</LiquidGlassPanel>;
  return <LiquidGlassPanel as="section" className={styles.agenda} aria-label={searching ? 'Event search results' : 'Events for selected date'}>
    {options}
    <div className={styles.agendaContent}>
      <NeumorphicTextField variant="standard" className={styles.searchField} type="search"
        aria-label="Search events" placeholder="Search events" value={query}
        onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} clearLabel="Clear event search"
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } }} />
      {searching ? <>
        <div className={styles.searchHeading}>
          <h2>Search results · {year}</h2>
          <div className={styles.actions}>
            <TooltipButton variant="ghost" size="icon" aria-label="Previous search year" title="Previous search year"
              disabled={year <= 1900} onClick={() => setYear(value => value - 1)}><ChevronLeft aria-hidden="true" /></TooltipButton>
            <TooltipButton variant="ghost" size="icon" aria-label="Next search year" title="Next search year"
              disabled={year >= 9998} onClick={() => setYear(value => value + 1)}><ChevronRight aria-hidden="true" /></TooltipButton>
          </div>
        </div>
        <p>Jan 1 – Dec 31, {year} · {calendarId ? 'Selected calendar' : 'All calendars'}</p>
      </> : <h2>{dayDate(day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', weekday: 'short' })}</h2>}
      <p role="status">{loading ? searching ? 'Searching events…' : 'Loading events…' : error ? 'Could not load events.'
        : searching ? events.length + historyCount ? `${events.length + historyCount} ${events.length + historyCount === 1 ? 'result' : 'results'}` : 'No matching events.'
          : message || (events.length + historyCount === 0 ? 'No events.' : `${events.length} events${historyCount ? ` · ${historyCount} executions` : ''}`)}</p>
      {searching && search.error && !state.error && <>
        <p role="alert">{search.error}</p>
        <NeumorphicButton variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry search</NeumorphicButton>
      </>}
    </div>
    <CalendarEventList events={events} calendars={state.calendars} searching={searching} onOpen={onOpen}
      scheduler={scheduler} day={day} query={query} year={year} calendarId={calendarId} />
  </LiquidGlassPanel>;
}
