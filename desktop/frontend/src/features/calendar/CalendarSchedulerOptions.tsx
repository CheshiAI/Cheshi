import { useState } from 'react';
import type { Schedule, SchedulerApi, SchedulerSnapshot } from '../../../../shared/scheduler';
import { NeumorphicButton } from '../../shared/ui';
import styles from './Calendar.module.css';

export function CalendarSchedulerOptions({ api, state, refresh, onEdit, calendarId }: {
  api: SchedulerApi; state: SchedulerSnapshot; refresh(): Promise<void>; onEdit(schedule: Schedule): void; calendarId?: string;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const schedules = state.schedules.filter(schedule => schedule.calendarLink?.state !== 'linked');
  if (!schedules.length && !error && !state.error) return null;
  return <div className={styles.calendarFilter}>
    {(error || state.error) && <p className={styles.hint} role="alert">{error || state.error}</p>}
    {schedules.map(schedule => <div key={schedule.id}>
      <p>{schedule.title}</p>
      {schedule.calendarLink ? <p className={styles.hint}>Migration needs checking in Apple Calendar. The previous task is paused.</p> : <div className={styles.actions}>
        <NeumorphicButton variant="ghost" disabled={busy} onClick={() => onEdit(schedule)}>Edit existing task</NeumorphicButton>
        {api.migrate && <NeumorphicButton variant="ghost" disabled={!calendarId || busy} onClick={() => { void perform(() => api.migrate!(schedule.id, schedule.revision, calendarId!)); }}>Move to Apple Calendar</NeumorphicButton>}
      </div>}
    </div>)}
  </div>;
}
