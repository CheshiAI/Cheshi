import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CalendarEvent } from '../../shared/apple-calendar.ts';
import { calendarOccurrenceKey, calendarTaskError, calendarTaskTitle, isCalendarTask } from '../../shared/calendar-task.ts';
import type { CalendarTask } from '../../shared/scheduler.ts';
import type { SchedulerStore } from './store.mts';

export function calendarTask(event: CalendarEvent): CalendarTask {
  const task: CalendarTask = { key: calendarOccurrenceKey(event), event, workspace: '*', input: null, error: calendarTaskError(event) };
  if (task.error) return task;
  try {
    const workspace = realpathSync.native(fileURLToPath(event.url!));
    if (!statSync(workspace).isDirectory() || workspace === '/') return { ...task, error: 'URL must point to an existing workspace folder.' };
    return { ...task, workspace, input: { title: calendarTaskTitle(event.title), prompt: event.notes.trim(), startAt: event.start,
      timeZone: event.timeZone, repeat: 'once', enabled: true, threadId: null, permissionMode: 'read-only', model: null, effort: 'medium' } };
  } catch { return { ...task, error: 'The workspace folder is unavailable. Check the event URL.' }; }
}

/** Apple owns the definitions; this cache is reconciled, never independently scheduled as a second source. */
export function syncCalendarTasks(store: SchedulerStore, events: CalendarEvent[], start: number, end: number, now: number): void {
  const tasks = events.filter(event => isCalendarTask(event.title)).map(calendarTask);
  for (const task of tasks) {
    const legacy = store.schedules().find(item => item.calendarLink?.eventId === task.event.id && item.workspace === task.workspace);
    if (legacy && task.input) task.input = { ...task.input, threadId: legacy.threadId, model: legacy.model,
      effort: legacy.effort, permissionMode: legacy.permissionMode };
  }
  const current = new Map(tasks.map(task => [task.key, task]));
  const inRange = (time: string) => Date.parse(time) >= start && Date.parse(time) < end;
  store.transaction(() => {
    for (const previous of store.calendarTasks()) {
      if (inRange(previous.event.start) && !current.has(previous.key)) store.removeCalendarTask(previous.key);
    }
    for (const task of tasks) store.putCalendarTask(task);
    for (const run of store.runs(['pending', 'approved', 'missed'])) {
      if (!run.scheduleId.startsWith('apple:') || !inRange(run.plannedAt)) continue;
      const task = current.get(run.scheduleId);
      if (!task?.input || task.event.start !== run.plannedAt) {
        store.putRun({ ...run, status: 'cancelled', finishedAt: new Date(now).toISOString(), summary: task?.error || 'Calendar task moved, removed, or no longer tagged [task].' });
      } else if (JSON.stringify(task.input) !== JSON.stringify(run.snapshot) || task.workspace !== run.workspace) {
        store.putRun({ ...run, title: task.input.title, workspace: task.workspace, snapshot: task.input,
          status: Date.parse(run.plannedAt) > now ? 'pending' : 'missed', approvedAt: null, dismissed: false,
          mode: run.status === 'approved' ? 'manual' : run.mode, summary: 'Calendar task changed; previous approval was cleared.' });
      }
    }
  });
}
