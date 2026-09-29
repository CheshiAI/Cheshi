import {
  calendarEventInput, CALENDAR_ERRORS,
  type AppleCalendarApi, type CalendarEvent, type CalendarEventInput,
} from '../../../../shared/apple-calendar';
import { addDays, dateTimeInstant, localDateTime } from './calendarDates';
import { calendarTaskError } from '../../../../shared/calendar-task';

export interface CalendarForm {
  calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string; notes: string; url?: string; repeat?: CalendarEventInput['repeat'];
}
export function createCalendarDraft(original: CalendarEvent | null, day: string, calendarId: string) {
  const form: CalendarForm = original ? { ...original,
    start: original.allDay ? original.start : localDateTime(original.start),
    end: original.allDay ? addDays(original.end, -1) : localDateTime(original.end),
  } : { calendarId, title: '', start: `${day}T09:00`, end: `${day}T10:00`, allDay: false, location: '', notes: '' };
  let state = { form, dirty: false, busy: false, blocked: false, error: '', completed: false };
  // Keep computed instants so repeated DST hours and original seconds cannot
  // change the one-hour interval when minute-only form values are saved.
  let timedInstants: Partial<Pick<CalendarEventInput, 'start' | 'end'>> = {};
  const listeners = new Set<() => void>();
  const patch = (value: Partial<typeof state>) => { state = { ...state, ...value }; listeners.forEach(listener => listener()); };
  const canEdit = () => !state.busy && !state.blocked && !state.completed && !original?.readOnly;
  const edit = (value: Partial<CalendarForm>, instants: typeof timedInstants = {}) => {
    if (!canEdit()) return;
    if (value.allDay !== undefined) timedInstants = {};
    for (const field of ['start', 'end'] as const) {
      if (value[field] !== undefined) delete timedInstants[field];
    }
    timedInstants = { ...timedInstants, ...instants };
    patch({ form: { ...state.form, ...value }, dirty: true, error: '' });
  };
  const input = (): CalendarEventInput => calendarEventInput({ ...state.form,
    timeZone: original?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    start: state.form.allDay ? state.form.start : timedInstants.start ?? (original && !original.allDay && state.form.start === localDateTime(original.start)
      ? original.start : dateTimeInstant(state.form.start)),
    end: state.form.allDay ? addDays(state.form.end, 1) : timedInstants.end ?? (original && !original.allDay && state.form.end === localDateTime(original.end)
      ? original.end : dateTimeInstant(state.form.end)),
  });
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit,
    editStart(start: string) {
      if (!canEdit() || start === state.form.start) return;
      if (state.form.allDay) { edit({ start }); return; }
      try {
        const startInstant = dateTimeInstant(start);
        const endInstant = new Date(Date.parse(startInstant) + 60 * 60_000).toISOString();
        edit({ start, end: localDateTime(endInstant) }, { start: startInstant, end: endInstant });
      } catch { patch({ error: CALENDAR_ERRORS.invalid }); }
    },
    toggleAllDay(allDay: boolean) {
      this.edit({ allDay, start: allDay ? state.form.start.slice(0, 10) : `${state.form.start}T09:00`,
        end: allDay ? state.form.end.slice(0, 10) : `${state.form.end}T10:00` });
    },
    async submit(api: AppleCalendarApi, remove = false): Promise<boolean> {
      if (state.busy || state.blocked || state.completed || original?.readOnly || (remove && !original)) return false;
      let event: CalendarEventInput | null = null;
      if (!remove) {
        try { event = input(); }
        catch { patch({ error: CALENDAR_ERRORS.invalid }); return false; }
        const taskError = calendarTaskError(event);
        if (taskError) { patch({ error: taskError }); return false; }
      }
      patch({ busy: true, error: '' });
      try {
        const result = remove && original ? await api.delete({ id: original.id, revision: original.revision })
          : original ? await api.update({ target: { id: original.id, revision: original.revision }, event: event! })
            : await api.create(event!);
        if (!result.ok) {
          patch({ error: result.error.message, blocked: ['write-unknown', 'conflict', 'not-found', 'read-only'].includes(result.error.code) });
          return false;
        }
        patch({ completed: true, dirty: false });
        return true;
      } catch {
        patch({ error: CALENDAR_ERRORS['write-unknown'], blocked: true });
        return false;
      } finally { patch({ busy: false }); }
    },
  };
}
