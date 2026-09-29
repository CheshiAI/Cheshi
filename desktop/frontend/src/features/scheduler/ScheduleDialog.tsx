import { Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Schedule, ScheduleInput, SchedulerApi } from '../../../../shared/scheduler';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LiquidGlassSelect, Modal, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { CalendarDateTimeField } from '../calendar/CalendarDateTimeField';
import { normalizeSessionsResponse } from '../chat/model';
import styles from './Scheduler.module.css';

function localDateTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function ScheduleDialog({ api, schedule, onClose, onSaved }: {
  api: SchedulerApi; schedule: Schedule | null; onClose(): void; onSaved(): void;
}) {
  const [input, setInput] = useState<ScheduleInput>(() => schedule ?? {
    title: '', prompt: '', startAt: new Date(Date.now() + 600_000).toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, repeat: 'once', enabled: true,
    threadId: null, permissionMode: 'read-only', model: null, effort: 'medium',
  });
  const [date, setDate] = useState(() => localDateTime(new Date(input.startAt)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'discard' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sessions, setSessions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    void cheshiDesktop?.listCodexChatSessions().then(value => {
      if (alive) setSessions(normalizeSessionsResponse(value).map(session => ({ value: session.id, label: session.title })));
    }).catch(() => { if (alive) setError('Could not load conversations. You can still start a new conversation.'); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, busy]);
  const edit = (patch: Partial<ScheduleInput>) => { setInput(current => ({ ...current, ...patch })); setDirty(true); };
  const submit = async (remove = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (remove && schedule) await api.remove(schedule.id, schedule.revision);
      else {
        const start = new Date(date);
        if (!Number.isFinite(start.getTime()) || localDateTime(start) !== date) throw new Error('Choose a valid local date and time.');
        await api.save({ ...input, startAt: start.toISOString() }, schedule ? { id: schedule.id, revision: schedule.revision } : undefined);
      }
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <>
    <Modal title={schedule ? 'SCHEDULED TASK' : 'NEW SCHEDULED TASK'} titleIcon={<Clock aria-hidden="true" />}
      headerVariant="section" closeButtonVariant="ghost" closeDisabled={busy || !!confirm}
      onClose={() => { if (dirty) setConfirm('discard'); else onClose(); }}>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className={styles.field}>Title<NeumorphicTextField variant="standard" value={input.title} required maxLength={1000}
          disabled={busy} onChange={event => edit({ title: event.target.value })} /></label>
        <label className={styles.field}>Task<NeumorphicTextField variant="standard" multiline rows={5} value={input.prompt} required maxLength={100_000}
          disabled={busy} onChange={event => edit({ prompt: event.target.value })} /></label>
        <CalendarDateTimeField label="Scheduled time" value={date} allDay={false} disabled={busy}
          onChange={value => { setDate(value); edit({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); }} />
        <p>Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Repeats follow {input.timeZone}.</p>
        <LiquidGlassSelect ariaLabel="Repeat task" triggerAppearance="standard" menuAppearance="toolbar" value={input.repeat}
          onChange={value => edit({ repeat: value as ScheduleInput['repeat'] })} disabled={busy}
          options={[{ value: 'once', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Every week' }]} />
        <LiquidGlassSelect ariaLabel="Task conversation" triggerAppearance="standard" menuAppearance="toolbar" value={input.threadId ?? ''}
          onChange={value => edit({ threadId: value || null })} disabled={busy}
          options={[{ value: '', label: 'New conversation for each run' }, ...sessions,
            ...(input.threadId && !sessions.some(item => item.value === input.threadId) ? [{ value: input.threadId, label: `Saved conversation · ${input.threadId}` }] : [])]} />
        <LiquidGlassSelect ariaLabel="Task permissions" triggerAppearance="standard" menuAppearance="toolbar" value={input.permissionMode}
          onChange={value => edit({ permissionMode: value as ScheduleInput['permissionMode'] })} disabled={busy}
          options={[{ value: 'read-only', label: 'Read only' }, { value: 'ask-for-approval', label: 'Workspace access · Ask for approval' }]} />
        <div className={styles.row}><span>Enabled</span><ToggleSwitch aria-label="Schedule enabled" checked={input.enabled}
          disabled={busy} onChange={enabled => edit({ enabled })} /></div>
        <p>Runs while Cheshi is open, including in the background, using the available Codex account. Missed tasks wait for your decision.</p>
        {error && <p role="alert">{error}</p>}
        <div className={styles.actions}>
          {schedule && <NeumorphicButton type="button" variant="ghost" disabled={busy} onClick={() => setConfirm('delete')}>Delete</NeumorphicButton>}
          <NeumorphicButton type="submit" variant="standard" disabled={busy || !input.title.trim() || !input.prompt.trim()}>{busy ? 'Saving…' : 'Save task'}</NeumorphicButton>
        </div>
      </form>
    </Modal>
    {confirm && <Modal title={confirm === 'delete' ? 'DELETE SCHEDULE' : 'DISCARD CHANGES'} headerVariant="section" closeButtonVariant="ghost"
      closeDisabled={busy} onClose={() => setConfirm(null)}>
      <div className={styles.form}><p>{confirm === 'delete' ? 'Delete this schedule? Past execution history will remain.' : 'Discard your changes?'}</p>
        {error && <p role="alert">{error}</p>}<div className={styles.actions}>
          <NeumorphicButton variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</NeumorphicButton>
          <NeumorphicButton variant="standard" disabled={busy} onClick={() => { if (confirm === 'delete') void submit(true); else onClose(); }}>
            {confirm === 'delete' ? 'Delete' : 'Discard'}</NeumorphicButton>
        </div></div>
    </Modal>}
  </>;
}
