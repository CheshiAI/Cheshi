import {
  appleCalendars, calendarAccess, calendarEvent, calendarEventInput, calendarEvents, calendarFailure,
  calendarQuery, calendarReply, calendarTarget, calendarUpdate,
} from '../shared/apple-calendar.ts';
import type { CalendarReply } from '../shared/apple-calendar.ts';
import { runCalendarCommand } from './apple-calendar-process.mts';

export class AppleCalendarService {
  private readonly platform: string;
  private readonly execute: (command: unknown) => Promise<unknown>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { platform?: string; execute?: (command: unknown) => Promise<unknown> } = {}) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? runCalendarCommand;
  }
  status() { return this.request(() => ({ action: 'status' }), calendarAccess); }
  connect() { return this.request(() => ({ action: 'connect' }), calendarAccess); }
  calendars() { return this.request(() => ({ action: 'calendars' }), appleCalendars); }
  async events(value: unknown) {
    const result = await this.request(() => ({ action: 'events', ...calendarQuery(value) }), calendarEvents);
    if (result.ok && typeof process.env.CHESHI_DEV_SHUTDOWN_DIRECTORY === 'string') {
      console.info(`[cheshi:calendar] Events validated: ${result.value.length}`);
    }
    return result;
  }
  create(value: unknown) { return this.request(() => ({ action: 'create', event: calendarEventInput(value) }), calendarEvent, true); }
  update(value: unknown) {
    return this.request(() => ({ action: 'update', ...calendarUpdate(value) }), reply => {
      const event = calendarEvent(reply);
      if (event.id !== calendarUpdate(value).target.id) throw new TypeError('Unexpected calendar event');
      return event;
    }, true);
  }
  delete(value: unknown) {
    return this.request(() => ({ action: 'delete', target: calendarTarget(value) }), reply => {
      const target = calendarTarget(reply);
      const expected = calendarTarget(value);
      if (target.id !== expected.id || target.revision !== expected.revision) throw new TypeError('Unexpected calendar target');
      return target;
    }, true);
  }
  private async request<T>(build: () => unknown, parse: (value: unknown) => T, mutation = false): Promise<CalendarReply<T>> {
    if (this.platform !== 'darwin') return calendarFailure('unsupported');
    let command: unknown;
    try { command = build(); }
    catch { return calendarFailure('invalid'); }
    const run = async (): Promise<CalendarReply<T>> => {
      let response: unknown;
      try { response = await this.execute(command); }
      catch { return calendarFailure(mutation ? 'write-unknown' : 'unavailable'); }
      try { return calendarReply(response, parse); }
      catch (error) {
        const knownReasons = new Set(['Invalid calendar object', 'Invalid calendar text', 'Invalid calendar flag',
          'Invalid calendar date', 'Invalid calendar interval', 'Invalid calendar time zone', 'Invalid calendar list',
          'Invalid calendar access', 'Invalid calendar reply', 'Invalid calendar interval: end before start',
          'Invalid calendar interval: same-day all-day event', 'Invalid calendar interval: zero duration']);
        const reason = error instanceof Error && knownReasons.has(error.message) ? error.message : 'Unknown validation failure';
        console.warn(`[cheshi:calendar] Response rejected: ${reason}`);
        return calendarFailure(mutation ? 'write-unknown' : 'invalid-response');
      }
    };
    // Serialize writes across windows so the next write checks the latest revision.
    if (!mutation) return run();
    const operation = this.queue.then(run);
    this.queue = operation;
    return operation;
  }
}
