import type { ScheduleInput } from './scheduler.ts';

function wallTime(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
}

/** Resolve the wall clock using offsets on both sides of a DST transition.
 * Repeated hours run once (earlier instant); nonexistent hours are skipped. */
function instant(wall: number, timeZone: string): number | null {
  const offsets = new Set([-2, -1, 0, 1, 2].map(days => {
    const sample = wall + days * 86_400_000;
    return wallTime(sample, timeZone) - sample;
  }));
  const matches = [...offsets].map(offset => wall - offset).filter(time => wallTime(time, timeZone) === wall);
  return matches.length ? Math.min(...matches) : null;
}

export function nextScheduleTime(schedule: ScheduleInput, after: number): string | null {
  const first = Date.parse(schedule.startAt);
  if (first > after) return schedule.startAt;
  if (schedule.repeat === 'once') return null;
  const step = (schedule.repeat === 'weekly' ? 7 : 1) * 86_400_000;
  const anchor = wallTime(first, schedule.timeZone);
  const wallNow = wallTime(after, schedule.timeZone);
  const count = Math.max(1, Math.floor((wallNow - anchor) / step));
  for (let offset = count; offset <= count + 8; offset++) {
    const time = instant(anchor + offset * step, schedule.timeZone);
    if (time !== null && time > after) return new Date(time).toISOString();
  }
  throw new Error('Could not resolve the next scheduled time');
}

export function scheduleTimes(schedule: ScheduleInput, start: number, end: number): string[] {
  const times: string[] = [];
  let next = nextScheduleTime(schedule, start - 1);
  while (next && Date.parse(next) < end && times.length < 400) {
    times.push(next);
    next = nextScheduleTime(schedule, Date.parse(next));
  }
  return times;
}
