import { CalendarDays } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { NeumorphicButton } from '../../shared/ui';
import { dayDate } from './calendarDates';
import { CalendarDateTimePopover } from './CalendarDateTimePopover';
import styles from './CalendarDateTimeField.module.css';

export function CalendarDateTimeField({ label, value, allDay, disabled, onChange }: {
  label: string; value: string; allDay: boolean; disabled: boolean; onChange: (value: string) => void;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  useEffect(() => { setAnchor(null); }, [disabled, allDay]);
  const hour = Number(value.slice(11, 13));
  const dateLabel = dayDate(value.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeLabel = `${String(hour % 12 || 12).padStart(2, '0')}:${value.slice(14, 16)} ${hour >= 12 ? 'PM' : 'AM'}`;
  const close = (restore = true) => {
    setAnchor(null);
    if (restore && anchor?.isConnected) anchor.focus({ preventScroll: true });
  };
  return <div className={styles.field}>
    <span>{label}</span>
    <NeumorphicButton variant="standard" className={styles.trigger} aria-label={`${label} ${allDay ? 'date' : 'date and time'}`}
      aria-haspopup="dialog" aria-expanded={!!anchor && !disabled} aria-controls={anchor && !disabled ? id : undefined}
      disabled={disabled} onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
      <CalendarDays aria-hidden="true" /><span>{allDay ? dateLabel : `${dateLabel} · ${timeLabel}`}</span>
    </NeumorphicButton>
    {anchor && !disabled && <CalendarDateTimePopover key={`${allDay}`} id={id} label={label} anchor={anchor}
      value={value} allDay={allDay} onClose={close}
      onApply={next => { if (next !== value) onChange(next); close(); }} />}
  </div>;
}
