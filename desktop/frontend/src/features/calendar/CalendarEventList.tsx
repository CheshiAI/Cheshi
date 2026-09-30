import { LockKeyhole } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { AppleCalendar, CalendarEvent } from '../../../../shared/apple-calendar';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { addDays, dayDate } from './calendarDates';
import styles from './Calendar.module.css';
import type { SchedulerSnapshot } from '../../../../shared/scheduler';
import { calendarOccurrenceKey, calendarTaskError, isCalendarTask } from '../../../../shared/calendar-task';
import { showSchedulerRun } from '../scheduler/SchedulerRunContent';

function eventDateLabel(event: CalendarEvent, search: boolean): string {
  if (event.allDay) {
    if (!search) return 'All day';
    const format = (day: string) => dayDate(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const last = addDays(event.end, -1);
    return `${format(event.start)}${last === event.start ? '' : ` – ${format(last)}`} · All day`;
  }
  const options = { month: search ? 'short' : 'numeric', day: 'numeric',
    ...(search ? { year: 'numeric' as const } : {}), hour: '2-digit', minute: '2-digit' } as const;
  return `${new Date(event.start).toLocaleString('en-US', options)} – ${new Date(event.end).toLocaleString('en-US', options)}`;
}

export function calendarRunHistory(scheduler: SchedulerSnapshot | undefined, events: CalendarEvent[],
  searching: boolean, day?: string, query = '', year?: number, calendarId?: string) {
  return scheduler?.runs.filter(run => {
    if (run.kind !== 'task' || events.some(event => run.scheduleId === calendarOccurrenceKey(event) && run.plannedAt === event.start)) return false;
    const source = scheduler.calendarTasks?.find(task => task.key === run.scheduleId)?.event;
    if (calendarId && source?.calendarId !== calendarId) return false;
    const date = new Date(run.plannedAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    return searching ? date.getFullYear() === year && `${run.title} ${run.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : local === day;
  }) ?? [];
}

export function CalendarEventList({ events, calendars, searching, onOpen, scheduler, day, query = '', year, calendarId, viewportRef: providedViewportRef }: {
  events: CalendarEvent[]; calendars: AppleCalendar[]; searching: boolean; onOpen: (event: CalendarEvent) => void;
  scheduler?: SchedulerSnapshot; day?: string; query?: string; year?: number; calendarId?: string;
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  const localViewportRef = useRef<HTMLDivElement>(null);
  const viewportRef = providedViewportRef ?? localViewportRef;
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useAutoHideScrollbars<HTMLDivElement>();
  const attach = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    return scrollbarRef(element);
  }, [scrollbarRef, viewportRef]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const view = viewport?.ownerDocument.defaultView;
    if (!viewport || !content || !view) return;
    const measure = () => {
      viewport.dataset.overflowing = String(viewport.scrollHeight > viewport.clientHeight);
    };
    measure();
    if (!view.ResizeObserver) {
      view.addEventListener('resize', measure);
      return () => view.removeEventListener('resize', measure);
    }
    const observer = new view.ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [events, scheduler?.runs, day, query, year, calendarId, viewportRef]);

  return <div ref={attach} className={styles.eventViewport} role="region" aria-label="Event list" tabIndex={0}>
    <div ref={contentRef}>
      {events.map(event => <div className={styles.event} key={`${event.id}:${event.start}`}>
        <button type="button" className={styles.eventDetails} onClick={() => onOpen(event)}>
        <strong>{event.title}</strong>
        <span>{eventDateLabel(event, searching)}</span>
        <span>{calendars.find(calendar => calendar.id === event.calendarId)?.title}{event.readOnly && <LockKeyhole aria-label="Read only" />}</span>
        {event.location && <span>{event.location}</span>}
        {isCalendarTask(event.title) && <span>{scheduler?.calendarTasks?.find(task => task.key === calendarOccurrenceKey(event))?.error || calendarTaskError(event) || 'Scheduled task'}</span>}
        </button>
        {scheduler?.runs.filter(run => run.scheduleId === calendarOccurrenceKey(event) && run.plannedAt === event.start).map(run =>
          <button type="button" className={styles.runLink} key={run.id} onClick={() => showSchedulerRun(run.id)}>{run.status} · View run</button>)}
      </div>)}
      {calendarRunHistory(scheduler, events, searching, day, query, year, calendarId).map(run => <button key={run.id} type="button" className={styles.event} onClick={() => showSchedulerRun(run.id)}>
        <strong>{run.title}</strong><span>{new Date(run.plannedAt).toLocaleString('en-US')}</span><span>{run.status} · View run</span>
      </button>)}
    </div>
  </div>;
}
