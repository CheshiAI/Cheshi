import { pathToFileURL } from 'node:url';
import type { AppleCalendarService } from '../apple-calendar-service.mts';
import type { SchedulerEngine } from './engine.mts';

/** Pause the old definition before writing. An uncertain acknowledgement must never create a second event. */
export async function migrateSchedule(engine: SchedulerEngine, calendar: Pick<AppleCalendarService, 'create'>,
  workspace: string, id: string, revision: number, calendarId: string): Promise<void> {
  const previous = engine.store.schedules().find(item => item.id === id && item.workspace === workspace && item.revision === revision);
  if (!previous || previous.calendarLink) throw new Error('This task changed or already has a calendar migration.');
  const plannedAt = engine.store.runs(['pending', 'approved']).find(run => run.scheduleId === `${id}:${revision}`)?.plannedAt ?? previous.nextAt;
  if (!previous.enabled || !plannedAt || Date.parse(plannedAt) <= Date.now()) throw new Error('Enable this task and choose a future start time before moving it.');
  if (engine.workspaceBusy(workspace)) throw new Error('Wait for the running task to finish.');
  const paused = engine.save(workspace, { ...previous, enabled: false, startAt: plannedAt }, previous);
  engine.store.putSchedule({ ...paused, calendarLink: { state: 'creating' } });
  let reply;
  try {
    reply = await calendar.create({ calendarId, title: `[task] ${previous.title}`, notes: previous.prompt,
      url: pathToFileURL(workspace).href, start: plannedAt, end: new Date(Date.parse(plannedAt) + 3_600_000).toISOString(),
      allDay: false, timeZone: previous.timeZone, location: '', repeat: previous.repeat });
  } catch { reply = null; }
  if (!reply || (!reply.ok && reply.error.code === 'write-unknown')) {
    engine.store.putSchedule({ ...paused, calendarLink: { state: 'unknown' } });
    throw new Error('Check Apple Calendar before creating another event. The previous task is paused because saving could not be confirmed.');
  }
  if (!reply.ok) { engine.store.putSchedule({ ...previous, revision: paused.revision, nextAt: plannedAt }); throw new Error(reply.error.message); }
  engine.store.putSchedule({ ...paused, calendarLink: { state: 'linked', eventId: reply.value.id } });
}
