import { CalendarDays, ChevronLeft, ChevronRight, LockKeyhole, PanelRight, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AppleCalendarApi, CalendarEvent } from '../../../../shared/apple-calendar';
import { cheshiDesktop } from '../../cheshiDesktop';
import {
  SidebarToggle,
  LiquidGlassPanel, NeumorphicButton, NeumorphicSurface, TwoTierHeader,
  draggableWindowRegionStyle, nonDraggableWindowRegionStyle,
} from '../../shared/ui';
import { CalendarEventDialog } from './CalendarEventDialog';
import { addDays, dayDate, eventOnDay, localDay, monthDays, monthQuery } from './calendarDates';
import { createCalendarModel } from './calendarModel';
import styles from './Calendar.module.css';

interface ViewProps { rightSidebarOpen: boolean; onToggleRightSidebar: () => void }
export function CalendarView(props: ViewProps) {
  const api = cheshiDesktop?.appleCalendar;
  return api?.available ? <CalendarBrowser {...props} api={api} /> : <main className={styles.workspace} aria-label="Calendar">
    <CalendarHeader {...props} /><p className={styles.notice}>Apple 캘린더 연동은 macOS용 Cheshi에서 사용할 수 있습니다.</p>
  </main>;
}

function CalendarHeader({ rightSidebarOpen, onToggleRightSidebar }: ViewProps) {
  return <TwoTierHeader style={draggableWindowRegionStyle} primary={<>
    <div className={styles.heading}>
      <NeumorphicButton raised aria-hidden="true" className="theme-toggle" disabled><CalendarDays aria-hidden="true" /></NeumorphicButton>
      <h1>Calendar</h1>
    </div>
    <div style={nonDraggableWindowRegionStyle}>
      <SidebarToggle raised size="icon" aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
        aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></SidebarToggle>
    </div>
  </>} />;
}

export function CalendarBrowser({ api, ...props }: ViewProps & { api: AppleCalendarApi }) {
  const [model] = useState(() => createCalendarModel(api));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [day, setDay] = useState(() => localDay(new Date()));
  const [month, setMonth] = useState(() => localDay(new Date()));
  const [calendarId, setCalendarId] = useState('');
  const [dialog, setDialog] = useState<{ event: CalendarEvent | null } | null>(null);
  const [message, setMessage] = useState('');
  const query = useMemo(() => monthQuery(month, calendarId), [month, calendarId]);
  useEffect(() => { void model.refresh(query); return () => model.dispose(); }, [model, query]);
  const days = useMemo(() => monthDays(month), [month]);
  const eventsByDay = useMemo(() => new Map(days.map(date => [date, state.events.filter(event => eventOnDay(event, date))])), [days, state.events]);
  const selectedEvents = eventsByDay.get(day) ?? [];
  const writable = state.calendars.filter(calendar => calendar.writable);
  const defaultCalendar = calendarId ? writable.find(calendar => calendar.id === calendarId)
    : writable.find(calendar => calendar.isDefault) ?? writable[0];
  const refresh = () => { setMessage(''); void model.refresh(query); };
  const moveMonth = (offset: number) => {
    const date = dayDate(`${month.slice(0, 7)}-01`);
    date.setMonth(date.getMonth() + offset);
    setMonth(localDay(date)); setDay(localDay(date)); setMessage('');
  };
  return <main className={styles.workspace} aria-label="Calendar">
    <CalendarHeader {...props} />
    <div className={styles.toolbar}>
      <NeumorphicSurface raised highlightFocus className={styles.selectSurface}>
        <select aria-label="표시할 캘린더" value={calendarId} disabled={state.loading || state.access !== 'full'}
          onChange={e => { setCalendarId(e.target.value); setMessage(''); }}>
          <option value="">모든 캘린더</option>
          {state.calendars.map(calendar => <option key={calendar.id} value={calendar.id}>
            {calendar.source} / {calendar.title}{calendar.writable ? '' : ' (읽기 전용)'}</option>)}
        </select>
      </NeumorphicSurface>
      <div className={styles.actions}>
        <NeumorphicButton raised size="icon" aria-label="캘린더 새로고침" title="새로고침" disabled={state.loading} onClick={refresh}><RefreshCw aria-hidden="true" /></NeumorphicButton>
        <NeumorphicButton raised size="icon" aria-label="새 일정" title="새 일정"
          disabled={!defaultCalendar || state.loading || !!state.error || state.access !== 'full'} onClick={() => setDialog({ event: null })}><Plus aria-hidden="true" /></NeumorphicButton>
      </div>
    </div>
    {state.error && <p className={styles.notice} role="alert">{state.error}</p>}
    {state.access !== 'full' ? <div className={styles.connect}>
      <CalendarDays aria-hidden="true" />
      <p>Apple 캘린더를 연결하면 일정을 확인하고 관리할 수 있습니다.</p>
      <NeumorphicButton disabled={state.loading} onClick={() => void model.refresh(query, true)}>
        {state.loading ? '연결 확인 중…' : 'Apple 캘린더 연결'}</NeumorphicButton>
    </div> : <div className={styles.content}>
      <section className={styles.month} aria-label="월간 달력" aria-busy={state.loading}>
        <div className={styles.monthHeader}>
          <h2>{dayDate(month).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' })}</h2>
          <div className={styles.actions}>
            <NeumorphicButton onClick={() => { const today = localDay(new Date()); setMonth(today); setDay(today); }}>오늘</NeumorphicButton>
            <NeumorphicButton raised size="icon" aria-label="이전 달" onClick={() => moveMonth(-1)}><ChevronLeft aria-hidden="true" /></NeumorphicButton>
            <NeumorphicButton raised size="icon" aria-label="다음 달" onClick={() => moveMonth(1)}><ChevronRight aria-hidden="true" /></NeumorphicButton>
          </div>
        </div>
        <div className={styles.weekdays} aria-hidden="true">{['일', '월', '화', '수', '목', '금', '토'].map(label => <span key={label}>{label}</span>)}</div>
        <div className={styles.grid}>
          {days.map(date => {
            const events = eventsByDay.get(date) ?? [];
            return <button key={date} type="button" className={styles.day}
              aria-label={`${date}, ${state.loading ? '일정 불러오는 중' : state.error ? '일정 조회 실패' : `일정 ${events.length}개`}`} aria-pressed={date === day}
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
              <span>{Number(date.slice(8))}</span>
              {events.slice(0, 2).map(event => <span className={styles.dayEvent} key={`${event.id}:${event.start}`}>{event.title}</span>)}
              {events.length > 2 && <span className={styles.more}>+{events.length - 2}</span>}
            </button>;
          })}
        </div>
      </section>
      <LiquidGlassPanel as="section" className={styles.agenda} aria-label="선택한 날짜의 일정">
        <h2>{dayDate(day).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}</h2>
        <p role="status">{state.loading ? '일정 불러오는 중…' : state.error ? '일정을 불러오지 못했습니다.'
          : message || (selectedEvents.length === 0 ? '일정이 없습니다.' : `${selectedEvents.length}개의 일정`)}</p>
        {selectedEvents.map(event => <button type="button" className={styles.event} key={`${event.id}:${event.start}`} onClick={() => setDialog({ event })}>
          <strong>{event.title}</strong>
          <span>{event.allDay ? '종일' : `${new Date(event.start).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} – ${new Date(event.end).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</span>
          <span>{state.calendars.find(calendar => calendar.id === event.calendarId)?.title}{event.readOnly && <LockKeyhole aria-label="읽기 전용" />}</span>
          {event.location && <span>{event.location}</span>}
        </button>)}
      </LiquidGlassPanel>
    </div>}
    {dialog && <CalendarEventDialog api={api} event={dialog.event} day={day} calendarId={defaultCalendar?.id ?? ''} calendars={state.calendars}
      onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setMessage('Apple 캘린더에 반영했습니다.'); void model.refresh(query); }} />}
  </main>;
}
