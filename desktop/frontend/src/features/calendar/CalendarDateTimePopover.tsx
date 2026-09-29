import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { addDays, dayDate, localDay, monthDays } from './calendarDates';
import styles from './CalendarDateTimeField.module.css';

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shiftMonth(value: string, offset: number) {
  const date = dayDate(value);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, last));
  return localDay(date);
}

export function CalendarDateTimePopover({ id, label, anchor, value, allDay, onClose, onApply }: {
  id: string; label: string; anchor: HTMLButtonElement; value: string; allDay: boolean;
  onClose: (restore?: boolean) => void; onApply: (value: string) => void;
}) {
  const [date, setDate] = useState(value.slice(0, 10));
  const [month, setMonth] = useState(date);
  const initialHour = Number(value.slice(11, 13));
  const [hour, setHour] = useState(String(initialHour % 12 || 12).padStart(2, '0'));
  const [minute, setMinute] = useState(value.slice(14, 16));
  const [period, setPeriod] = useState(initialHour >= 12 ? 'PM' : 'AM');
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  const focusDate = useRef(false);
  const days = monthDays(month);
  const today = localDay(new Date());
  const valid = allDay || (/^\d{1,2}$/.test(hour) && Number(hour) >= 1 && Number(hour) <= 12
    && /^\d{1,2}$/.test(minute) && Number(minute) <= 59);

  useLayoutEffect(() => {
    const panel = root.current;
    const document = anchor.ownerDocument;
    const view = document.defaultView;
    if (!panel || !view) return;
    const position = () => {
      const bounds = anchor.getBoundingClientRect();
      const size = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(bounds.left, view.innerWidth - size.width - 8))}px`;
      const below = bounds.bottom + 8;
      const top = below + size.height <= view.innerHeight - 8 ? below : bounds.top - size.height - 8;
      panel.style.top = `${Math.max(8, Math.min(top, view.innerHeight - size.height - 8))}px`;
    };
    position();
    const target = panel.querySelector<HTMLElement>('button[data-date][aria-pressed="true"]');
    target?.focus({ preventScroll: true });
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !anchor.contains(event.target)) latest.current(false);
    };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); latest.current();
      }
      if (event.key === 'Tab') {
        const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter(node => node.tabIndex >= 0);
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keyboard, true);
    view.addEventListener('resize', position);
    view.addEventListener('scroll', position, true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position);
    observer?.observe(panel);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keyboard, true);
      view.removeEventListener('resize', position);
      view.removeEventListener('scroll', position, true);
      observer?.disconnect();
    };
  }, [anchor]);

  useLayoutEffect(() => {
    if (!focusDate.current) return;
    root.current?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus({ preventScroll: true });
    focusDate.current = false;
  }, [date, month]);

  const selectDate = (next: string, focus = false) => {
    focusDate.current = focus;
    setDate(next); setMonth(next);
  };
  const navigateDay = (event: KeyboardEvent<HTMLButtonElement>, current: string) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    let next: string | undefined;
    if (offset !== undefined) next = addDays(current, offset);
    else if (event.key === 'Home') next = addDays(current, -dayDate(current).getDay());
    else if (event.key === 'End') next = addDays(current, 6 - dayDate(current).getDay());
    else if (event.key === 'PageUp' || event.key === 'PageDown') next = shiftMonth(current, event.key === 'PageUp' ? -1 : 1);
    if (next) { event.preventDefault(); selectDate(next, true); }
  };
  const apply = () => {
    if (!valid) return;
    const hours = Number(hour) % 12 + (period === 'PM' ? 12 : 0);
    onApply(allDay ? date : `${date}T${String(hours).padStart(2, '0')}:${minute.padStart(2, '0')}`);
  };
  return createPortal(<div ref={root} className={styles.anchor} onKeyDown={event => {
    // This portal belongs to the event form; Enter must not submit that form.
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); apply(); }
  }}>
    <LiquidGlassPanel id={id} role="dialog" aria-label={`${label} ${allDay ? 'date' : 'date and time'}`}
      data-liquid-glass-backdrop="true" className={styles.panel}>
      <div className={styles.monthHeader}>
        <span aria-live="polite">{dayDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <div className={styles.actions}>
          <TooltipButton variant="ghost" size="icon" aria-label="Previous month" title="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft aria-hidden="true" /></TooltipButton>
          <TooltipButton variant="ghost" size="icon" aria-label="Next month" title="Next month" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight aria-hidden="true" /></TooltipButton>
        </div>
      </div>
      <div role="grid" aria-label="Choose date" className={styles.calendar}>
        <div role="row" className={styles.week}>
          {weekdays.map(day => <span role="columnheader" key={day} className={styles.weekday}>{day}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, row) => <div role="row" key={row} className={styles.week}>
          {days.slice(row * 7, row * 7 + 7).map(day => <div role="gridcell" key={day} aria-selected={day === date}>
            <NeumorphicButton variant="ghost" className={styles.day} data-date={day} aria-label={day}
              aria-pressed={day === date} aria-current={day === today ? 'date' : undefined}
              data-outside={day.slice(0, 7) !== month.slice(0, 7)}
              tabIndex={day === date || (!days.includes(date) && day === `${month.slice(0, 7)}-01`) ? 0 : -1}
              onClick={() => selectDate(day)} onKeyDown={event => navigateDay(event, day)}>
              <span className={styles.dayNumber}>{Number(day.slice(8))}</span>
            </NeumorphicButton>
          </div>)}
        </div>)}
      </div>
      {!allDay && <div className={styles.time}>
        <span className={styles.timeLabel}>Time</span>
        <div className={styles.clock}>
          <NeumorphicTextField variant="standard" aria-label="Hour" inputMode="numeric" maxLength={2}
            className={styles.number} value={hour} onChange={event => setHour(event.target.value)}
            onFocus={event => event.target.select()} aria-invalid={!/^\d{1,2}$/.test(hour) || Number(hour) < 1 || Number(hour) > 12} />
          <span aria-hidden="true">:</span>
          <NeumorphicTextField variant="standard" aria-label="Minute" inputMode="numeric" maxLength={2}
            className={styles.number} value={minute} onChange={event => setMinute(event.target.value)}
            onFocus={event => event.target.select()} aria-invalid={!/^\d{1,2}$/.test(minute) || Number(minute) > 59} />
        </div>
        <div className={styles.period} role="group" aria-label="Time period">
          {['AM', 'PM'].map(item => <NeumorphicButton key={item} variant="ghost" aria-pressed={period === item}
            onClick={() => setPeriod(item)}>{item}</NeumorphicButton>)}
        </div>
      </div>}
      {!valid && <p className={styles.error} role="alert">Enter an hour from 1 to 12 and minutes from 00 to 59.</p>}
      <div className={styles.footer}>
        <NeumorphicButton variant="ghost" onClick={() => selectDate(today)}>Today</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={!valid} onClick={apply}>Done</NeumorphicButton>
      </div>
    </LiquidGlassPanel>
  </div>, anchor.closest('dialog') ?? anchor.ownerDocument.body);
}
