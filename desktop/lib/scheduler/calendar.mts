import type { AppleCalendarService } from '../apple-calendar-service.mts';
import { schedulerTimer, type SchedulerEngine } from './engine.mts';
import type { CalendarReply } from '../../shared/apple-calendar.ts';

function requireCalendarValue<T>(reply: CalendarReply<T>, message: string): T {
  if (!reply.ok) throw new Error(message);
  return reply.value;
}

/** Refresh on invalidation and at the end of the cached range, never on an idle interval. */
export function createSchedulerCalendar(options: {
  calendar: Pick<AppleCalendarService, 'status' | 'events'>;
  engine: Pick<SchedulerEngine, 'syncEvents'> & Partial<Pick<SchedulerEngine, 'invalidateCalendar'>>;
  error(message: string): void;
  now?: () => number; timer?: typeof schedulerTimer;
}) {
  const now = options.now ?? Date.now;
  const timer = options.timer ?? schedulerTimer;
  let stopped = false;
  let suspended = false;
  let generation = 0;
  let pending: Promise<void> | undefined;
  let cancel: (() => void) | undefined;
  const refresh = (): Promise<void> => {
    options.engine.invalidateCalendar?.();
    generation++;
    cancel?.(); cancel = undefined;
    if (stopped || suspended) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      let reading: number;
      do {
        reading = generation;
        const start = now() - 60_000;
        const end = now() + 86_400_000;
        try {
          const access = await options.calendar.status();
          if (stopped || suspended) return;
          if (reading !== generation) continue;
          if (requireCalendarValue(access, 'Calendar access could not be checked.') !== 'full') {
            options.engine.syncEvents([], 0, Number.MAX_SAFE_INTEGER);
            options.error(''); return;
          }
          const result = await options.calendar.events({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), calendarId: '' });
          if (stopped || suspended) return;
          if (reading !== generation) continue;
          options.engine.syncEvents(requireCalendarValue(result, 'Calendar reminders could not be refreshed.'), start, end);
          options.error('');
          // Renew before any event outside this range needs its five-minute reminder.
          cancel = timer(() => { void refresh(); }, Math.max(1000, end - 300_000 - now()));
        } catch (error) {
          if (!stopped && !suspended && reading === generation) options.error(error instanceof Error ? error.message : String(error));
        }
      } while (!stopped && !suspended && reading !== generation);
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return { refresh,
    suspend() { suspended = true; generation++; options.engine.invalidateCalendar?.(); cancel?.(); cancel = undefined; },
    resume() { suspended = false; return refresh(); },
    async stop() { stopped = true; generation++; cancel?.(); await pending; },
  };
}
