import { CalendarDays, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppleCalendar, AppleCalendarApi, CalendarEvent } from '../../../../shared/apple-calendar';
import { Modal, NeumorphicButton, LiquidGlassSelect, NeumorphicTextField } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { CalendarDateTimeField } from './CalendarDateTimeField';
import { createCalendarDraft } from './calendarDraft';
import styles from './Calendar.module.css';
import { isCalendarTask } from '../../../../shared/calendar-task';

export function CalendarEventDialog({ api, event, day, calendarId, calendars, onClose, onChanged }: {
  api: AppleCalendarApi; event: CalendarEvent | null; day: string; calendarId: string;
  calendars: AppleCalendar[]; onClose: () => void; onChanged: () => void;
}) {
  const [draft] = useState(() => createCalendarDraft(event, day, calendarId));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null);
  const alive = useRef(true);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const preventClose = (close: BeforeUnloadEvent) => {
      if (state.dirty || state.busy) { close.preventDefault(); close.returnValue = ''; }
    };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [state.dirty, state.busy]);
  const readOnly = event?.readOnly === true;
  const disabled = state.busy || state.blocked || readOnly;
  const submit = async (remove = false) => {
    if (await draft.submit(api, remove)) { if (alive.current) { setConfirm(null); onChanged(); } }
  };
  const close = () => { if (!state.busy && confirm !== 'delete') { if (state.dirty) setConfirm('discard'); else onClose(); } };
  const cancelDelete = () => { if (!draft.getSnapshot().busy) setConfirm(null); };
  return <><Modal title={event ? 'EVENT' : 'NEW EVENT'} headerVariant="section" closeButtonVariant="ghost" titleIcon={<CalendarDays aria-hidden="true" />}
    onClose={close} closeDisabled={state.busy || confirm === 'delete'}>
    <form className={styles.form} onSubmit={e => { e.preventDefault(); if (!confirm) void submit(); }}>
      {readOnly && <p className={styles.hint}>Recurring events, invitations and read-only calendars must be edited in Apple Calendar.</p>}
      {state.error && confirm !== 'delete' && <p className={styles.hint} role="alert">{state.error}</p>}
      <div className={styles.field}><span>Calendar</span>
        <LiquidGlassSelect ariaLabel="Event calendar" triggerAppearance="standard" menuAppearance="toolbar"
          value={state.form.calendarId} disabled={disabled || !!event} placeholder="No calendars available"
          onChange={value => draft.edit({ calendarId: value })}
          options={calendars.filter(calendar => calendar.writable || calendar.id === event?.calendarId).map(calendar => ({
            value: calendar.id, label: `${calendar.source} / ${calendar.title}`,
          }))} />
      </div>
      <label className={styles.field}>Title<NeumorphicTextField variant="standard" aria-label="Event title" value={state.form.title}
        required maxLength={1000} disabled={disabled} onChange={e => draft.edit({ title: e.target.value })} /></label>
      <div className={styles.switchField}><span>All day</span>
        <ToggleSwitch aria-label="All day" checked={state.form.allDay} disabled={disabled}
          onChange={value => draft.toggleAllDay(value)} />
      </div>
      <div className={styles.dateFields}>
        <CalendarDateTimeField label="Start" value={state.form.start} allDay={state.form.allDay}
          disabled={disabled} onChange={start => draft.editStart(start)} />
        <CalendarDateTimeField label={state.form.allDay ? 'Last day' : 'End'} value={state.form.end} allDay={state.form.allDay}
          disabled={disabled} onChange={end => draft.edit({ end })} />
      </div>
      {!state.form.allDay && <p className={styles.hint}>Times shown in: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>}
      <label className={styles.field}>Location<NeumorphicTextField variant="standard" aria-label="Location" value={state.form.location}
        maxLength={4000} disabled={disabled} onChange={e => draft.edit({ location: e.target.value })} /></label>
      <label className={styles.field}>Notes<NeumorphicTextField variant="standard" aria-label="Event notes" multiline rows={5} value={state.form.notes}
        maxLength={100_000} disabled={disabled} onChange={e => draft.edit({ notes: e.target.value })} /></label>
      <label className={styles.field}>URL<NeumorphicTextField variant="standard" aria-label="Event URL" value={state.form.url ?? ''}
        maxLength={16_384} disabled={disabled} onChange={e => draft.edit({ url: e.target.value })} /></label>
      {isCalendarTask(state.form.title) && <p className={styles.hint}>Notes are the task instructions. URL is the workspace folder (file:///…). Cheshi runs the task at Start.</p>}
      {!event && isCalendarTask(state.form.title) && <div className={styles.field}><span>Repeat</span>
        <LiquidGlassSelect ariaLabel="Repeat task" triggerAppearance="standard" menuAppearance="toolbar" value={state.form.repeat ?? 'once'}
          onChange={value => draft.edit({ repeat: value as 'once' | 'daily' | 'weekly' })}
          options={[{ value: 'once', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Every week' }]} />
      </div>}
      {confirm === 'discard' ? <div className={styles.confirm}>
        <p>Discard unsaved changes and close?</p>
        <div className={styles.actions}>
          <NeumorphicButton variant="standard" type="button" disabled={state.busy} onClick={() => setConfirm(null)}>Cancel</NeumorphicButton>
          <NeumorphicButton variant="standard" type="button" disabled={state.busy}
            onClick={onClose}>Discard and close</NeumorphicButton>
        </div>
      </div> : <div className={styles.actions}>
        {event && !readOnly && <NeumorphicButton variant="standard" type="button" disabled={disabled || confirm === 'delete'}
          onClick={click => { deleteTriggerRef.current = click.currentTarget; setConfirm('delete'); }}>
          <Trash2 aria-hidden="true" />Delete</NeumorphicButton>}
        <NeumorphicButton variant="standard" type="button" disabled={state.busy || confirm === 'delete'} onClick={close}>Close</NeumorphicButton>
        {!readOnly && <NeumorphicButton variant="standard" type="submit" disabled={disabled || confirm === 'delete' || !state.form.title.trim() || (!!event && !state.dirty)}>
          {state.busy ? 'Saving…' : 'Save'}</NeumorphicButton>}
      </div>}
    </form>
  </Modal>
    {confirm === 'delete' && event && <Modal title="DELETE EVENT" titleIcon={<Trash2 aria-hidden="true" />}
      headerVariant="section" closeButtonVariant="ghost" className={styles.deleteDialog}
      onClose={cancelDelete} closeDisabled={state.busy}
      restoreFocus={() => { deleteTriggerRef.current?.focus(); return false; }}>
      <form className={styles.deleteConfirm} onSubmit={e => { e.preventDefault(); void submit(true); }}>
        <p className={styles.deleteEventTitle}>{event.title}</p>
        <p>Delete this event from Apple Calendar?</p>
        {state.error && <p role="alert">{state.error}</p>}
        <div className={styles.actions}>
          <NeumorphicButton variant="standard" type="button" autoFocus disabled={state.busy} onClick={cancelDelete}>Cancel</NeumorphicButton>
          <NeumorphicButton variant="standard" type="submit" disabled={disabled} aria-busy={state.busy}>
            {state.busy ? 'Deleting…' : 'Delete'}</NeumorphicButton>
        </div>
      </form>
    </Modal>}
  </>;
}
