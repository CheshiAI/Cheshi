import {
  calendarEventInput, CALENDAR_ERRORS,
  type AppleCalendarApi, type CalendarEvent, type CalendarEventInput,
} from '../../../../shared/apple-calendar';
import { addDays, dateTimeInstant, localDateTime } from './calendarDates';

export interface CalendarForm {
  calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string; notes: string;
}
export function createCalendarDraft(original: CalendarEvent | null, day: string, calendarId: string) {
  const form: CalendarForm = original ? { ...original,
    start: original.allDay ? original.start : localDateTime(original.start),
    end: original.allDay ? addDays(original.end, -1) : localDateTime(original.end),
  } : { calendarId, title: '', start: `${day}T09:00`, end: `${day}T10:00`, allDay: false, location: '', notes: '' };
  let state = { form, dirty: false, busy: false, blocked: false, error: '', completed: false };
  const listeners = new Set<() => void>();
  const patch = (value: Partial<typeof state>) => { state = { ...state, ...value }; listeners.forEach(listener => listener()); };
  const input = (): CalendarEventInput => calendarEventInput({ ...state.form,
    timeZone: original?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    start: state.form.allDay ? state.form.start : original && !original.allDay && state.form.start === localDateTime(original.start)
      ? original.start : dateTimeInstant(state.form.start),
    end: state.form.allDay ? addDays(state.form.end, 1) : original && !original.allDay && state.form.end === localDateTime(original.end)
      ? original.end : dateTimeInstant(state.form.end),
  });
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(value: Partial<CalendarForm>) {
      if (state.busy || state.blocked || state.completed || original?.readOnly) return;
      patch({ form: { ...state.form, ...value }, dirty: true, error: '' });
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
