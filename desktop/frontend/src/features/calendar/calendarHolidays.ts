import type { AppleCalendar } from '../../../../shared/apple-calendar';

/** Display policy only: never modifies the native calendars or their events. */
export function hiddenHolidayCalendarIds(calendars: readonly AppleCalendar[]): Set<string> {
  // EventKit exposes subscription type, not the publisher URL. Deliberately
  // recognize only the observed Korean holiday feeds; names alone are unsafe.
  const preferred = calendars.filter(calendar => calendar.writable === false
    && calendar.kind === 'subscription' && calendar.isSubscribed === true
    && calendar.title.trim() === '대한민국 공휴일');
  if (preferred.length !== 1) return new Set();

  return new Set(calendars.filter(calendar => calendar.writable === false
    && calendar.kind === 'caldav' && /^Google(?:@|$)/i.test(calendar.source.trim())
    && calendar.title.trim() === '대한민국의 휴일').map(calendar => calendar.id));
}
