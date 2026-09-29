import { useScheduler } from '../scheduler/useScheduler';
import { CalendarSchedulerOptions } from './CalendarSchedulerOptions';
import { ScheduleDialog } from '../scheduler/ScheduleDialog';
import { scheduleTimes } from '../../../../shared/scheduler-time';
import type { Schedule } from '../../../../shared/scheduler';
import { CalendarDays, ChevronLeft, ChevronRight, PanelRight, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { calendarFailure } from '../../../../shared/apple-calendar';
import type { AppleCalendarApi, CalendarEvent } from '../../../../shared/apple-calendar';
import { cheshiDesktop } from '../../cheshiDesktop';
import { SidebarToggle, SidebarPanelHeader, LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { CalendarAccessState } from './CalendarAccessState';
import { CalendarAgenda } from './CalendarAgenda';
import { CalendarEventDialog } from './CalendarEventDialog';
import { addDays, dayDate, eventOnDay, localDay, monthDays, monthQuery } from './calendarDates';
import { createCalendarModel } from './calendarModel';
import styles from './Calendar.module.css';

const unavailable = async () => calendarFailure<never>('unsupported');
const disconnectedCalendar: AppleCalendarApi = { available: false, status: unavailable, connect: unavailable, calendars: unavailable,
  events: unavailable, create: unavailable, update: unavailable, delete: unavailable };

interface ViewProps { rightSidebarOpen: boolean; onToggleRightSidebar: () => void }
export function CalendarView(props: ViewProps) {
  const api = cheshiDesktop?.appleCalendar ?? (cheshiDesktop?.scheduler ? disconnectedCalendar : undefined);
  return api && (api.available || cheshiDesktop?.scheduler) ? <CalendarBrowser {...props} api={api} /> : <main className={styles.workspace} aria-label="Calendar">
    <CalendarHeader {...props} /><p className={styles.notice}>Apple Calendar integration is available in Cheshi for macOS.</p>
  </main>;
}

function CalendarHeader({ rightSidebarOpen, onToggleRightSidebar }: ViewProps) {
  return <SidebarPanelHeader title="CALENDAR" icon={<CalendarDays aria-hidden="true" />} actions={
    <SidebarToggle raised size="icon" aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
      aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></SidebarToggle>
  } />;
}

export function CalendarBrowser({ api, ...props }: ViewProps & { api: AppleCalendarApi }) {
  const workspaceRef = useRef<HTMLElement>(null);
  const [model] = useState(() => createCalendarModel(api));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [day, setDay] = useState(() => localDay(new Date()));
  const [month, setMonth] = useState(() => localDay(new Date()));
  const [calendarId, setCalendarId] = useState('');
  const [dialog, setDialog] = useState<{ event: CalendarEvent | null } | null>(null);
  const [message, setMessage] = useState('');
  const scheduler = useScheduler();
  const [taskDialog, setTaskDialog] = useState<{ schedule: Schedule | null } | null>(null);
  const query = useMemo(() => monthQuery(month, calendarId), [month, calendarId]);
  useEffect(() => { void model.refresh(query); return () => model.dispose(); }, [model, query]);
  useEffect(() => { if (scheduler.state.calendarVersion) void model.refresh(query); }, [model, query, scheduler.state.calendarVersion]);
  useEffect(() => {
    if (!state.loading && !state.error && state.access === 'full' && calendarId
      && !state.calendars.some(calendar => calendar.id === calendarId)) setCalendarId('');
  }, [state.loading, state.error, state.access, state.calendars, calendarId]);
  const days = useMemo(() => monthDays(month), [month]);
  const eventsByDay = useMemo(() => new Map(days.map(date => [date, state.events.filter(event => eventOnDay(event, date))])), [days, state.events]);
  const tasksByDay = useMemo(() => {
    const entries = new Map<string, Map<string, string>>();
    const add = (time: string, key: string, title: string) => {
      const date = localDay(new Date(time)); const values = entries.get(date) ?? new Map<string, string>();
      values.set(key, title); entries.set(date, values);
    };
    for (const schedule of scheduler.state.schedules.filter(item => item.enabled)) {
      for (const time of scheduleTimes(schedule, dayDate(days[0]!).getTime(), dayDate(addDays(days.at(-1)!, 1)).getTime())) {
        if (Date.parse(time) >= Date.now()) add(time, `${schedule.id}:${schedule.revision}:${time}`, schedule.title);
      }
    }
    for (const run of scheduler.state.runs) if (run.kind === 'task' && !run.scheduleId.startsWith('apple:')) add(run.plannedAt, `${run.scheduleId}:${run.plannedAt}`, `${run.title} · ${run.status}`);
    return entries;
  }, [days, scheduler.state]);
  const writable = state.calendars.filter(calendar => calendar.writable);
  const defaultCalendar = calendarId ? writable.find(calendar => calendar.id === calendarId)
    : writable.find(calendar => calendar.isDefault) ?? writable[0];
  const refresh = () => { setMessage(''); void model.refresh(query); };
  const moveMonth = (offset: number) => {
    const date = dayDate(`${month.slice(0, 7)}-01`);
    date.setMonth(date.getMonth() + offset);
    setMonth(localDay(date)); setDay(localDay(date)); setMessage('');
  };
  return <main ref={workspaceRef} className={styles.workspace} aria-label="Calendar">
    <CalendarHeader {...props} />
    {state.access === 'full' && state.error && <p className={styles.notice} role="alert">{state.error}</p>}
    {state.access !== 'full' && !scheduler.api ? <CalendarAccessState state={state} onRetry={refresh}
      onConnect={() => { setMessage(''); void model.refresh(query, true); }} /> : <div className={styles.content}>
      <section className={styles.month} aria-label="Monthly calendar" aria-busy={state.loading}>
        <div className={styles.monthHeader}>
          <h2>{dayDate(month).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}</h2>
          <div className={styles.actions}>
            <NeumorphicButton variant="ghost" onClick={() => { const today = localDay(new Date()); setMonth(today); setDay(today); }}>Today</NeumorphicButton>
            <TooltipButton variant="ghost" size="icon" aria-label="Previous month" title="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft aria-hidden="true" /></TooltipButton>
            <TooltipButton variant="ghost" size="icon" aria-label="Next month" title="Next month" onClick={() => moveMonth(1)}><ChevronRight aria-hidden="true" /></TooltipButton>
          </div>
        </div>
        <div className={styles.weekdays} aria-hidden="true">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(label => <span key={label}>{label}</span>)}</div>
        <div className={styles.grid}>
          {days.map(date => {
            const events = eventsByDay.get(date) ?? [];
            const scheduled = [...(tasksByDay.get(date)?.values() ?? [])];
            return <button key={date} type="button" className={styles.day}
              aria-label={`${date}, ${state.loading ? 'Loading events' : state.error ? 'Could not load events' : `${events.length} events`}${scheduler.api ? `, ${scheduled.length} tasks` : ''}`} aria-pressed={date === day}
              aria-current={date === localDay(new Date()) ? 'date' : undefined} data-outside={date.slice(0, 7) !== month.slice(0, 7)}
              onClick={() => setDay(date)} onKeyDown={e => {
                const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
                if (offset === undefined) return;
                e.preventDefault();
                const next = addDays(date, offset);
                setDay(next);
                if (!days.includes(next)) setMonth(next);
                else {
                  const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');
                  buttons?.[days.indexOf(next)]?.focus();
                }
              }}>
              <span className={styles.dayNumber}>{Number(date.slice(8))}</span>
              {events.slice(0, 2).map(event => <span className={styles.dayEvent} key={`${event.id}:${event.start}`}>{event.title}</span>)}
              {scheduled.slice(0, Math.max(1, 2 - events.length)).map((title, index) => <span className={styles.dayEvent} key={`task-${index}`}>Task · {title}</span>)}
              {events.length > 2 && <span className={styles.more}>+{events.length - 2}</span>}
            </button>;
          })}
        </div>
      </section>
      <CalendarAgenda api={api} state={state} calendarId={calendarId} day={day} message={message}
        scheduler={scheduler.state}
        panel={state.access !== 'full' ? <CalendarAccessState state={state} onRetry={refresh} onConnect={() => void model.refresh(query, true)} /> : undefined}
        onOpen={event => setDialog({ event })} options={<div className={styles.options} aria-label="Calendar options" role="group">
          <SidebarPanelHeader title="OPTION" actions={<>
            <TooltipButton variant="ghost" size="icon" aria-label="Refresh calendars" title="Refresh calendars"
              disabled={state.loading} onClick={refresh}><RefreshCw aria-hidden="true" /></TooltipButton>
            <TooltipButton variant="ghost" size="icon" aria-label="New event" title="New event"
              disabled={!defaultCalendar || state.loading || !!state.error || state.access !== 'full'}
              onClick={() => setDialog({ event: null })}><Plus aria-hidden="true" /></TooltipButton>
          </>} />
          {scheduler.api && <CalendarSchedulerOptions api={scheduler.api} state={scheduler.state} refresh={scheduler.refresh}
            calendarId={defaultCalendar?.id} onEdit={schedule => setTaskDialog({ schedule })} />}
          <div className={styles.calendarFilter}>
            <LiquidGlassSelect ariaLabel="Displayed calendar" value={calendarId}
              triggerAppearance="standard" menuAppearance="toolbar" menuBlurSourceRef={workspaceRef}
              disabled={state.loading || state.access !== 'full'}
              onChange={value => { setCalendarId(value); setMessage(''); }}
              options={[{ value: '', label: 'All calendars' }, ...state.calendars.map(calendar => ({
                value: calendar.id, label: `${calendar.source} / ${calendar.title}${calendar.writable ? '' : ' (Read only)'}`,
              }))]} />
          </div>
        </div>} />
    </div>}
    {taskDialog && scheduler.api && <ScheduleDialog api={scheduler.api} schedule={taskDialog.schedule}
      onClose={() => setTaskDialog(null)} onSaved={() => { setTaskDialog(null); void scheduler.refresh(); }} />}
    {dialog && <CalendarEventDialog api={api} event={dialog.event} day={day} calendarId={defaultCalendar?.id ?? ''} calendars={state.calendars}
      onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setMessage('Saved to Apple Calendar.'); void model.refresh(query); }} />}
  </main>;
}
