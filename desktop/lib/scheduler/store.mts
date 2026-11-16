import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SCHEDULER_NOTIFICATION_POSITION, schedulerNotificationPosition, type SchedulerNotificationPosition } from '../../shared/scheduler.ts';
import type { CalendarTask, RunStatus, Schedule, ScheduleInput, ScheduleRun } from '../../shared/scheduler.ts';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: (string | number | null)[]): unknown; get(...values: (string | number | null)[]): unknown; all(...values: (string | number | null)[]): unknown[] };
  close(): void;
}
export async function openSchedulerStore(filename: string): Promise<SchedulerStore> {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = process.versions.bun ? new (await import('bun:sqlite')).Database(filename, { create: true })
    : new (await import('node:sqlite')).DatabaseSync(filename);
  return new SchedulerStore(db);
}

export class SchedulerStore {
  private readonly db: Database;
  private readonly listeners = new Set<() => void>();
  private inTransaction = false;
  private dirty = false;
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void {
    if (this.inTransaction) { this.dirty = true; return; }
    this.listeners.forEach(listener => listener());
  }
  constructor(db: Database) {
    this.db = db;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scheduler_settings (id INTEGER PRIMARY KEY CHECK(id=1), auto INTEGER NOT NULL);
      INSERT OR IGNORE INTO scheduler_settings VALUES(1,0);
      CREATE TABLE IF NOT EXISTS scheduler_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, planned_at TEXT NOT NULL,
        workspace TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(schedule_id,planned_at));
      CREATE INDEX IF NOT EXISTS schedule_runs_workspace ON schedule_runs(workspace,planned_at);
      CREATE INDEX IF NOT EXISTS schedule_runs_status ON schedule_runs(json_extract(data,'$.status'));`);
  }
  private rows<T>(sql: string, ...values: string[]): T[] {
    return this.db.prepare(sql).all(...values).map(row => JSON.parse((row as { data: string }).data) as T);
  }
  schedules(): Schedule[] { return this.rows<Schedule>('SELECT data FROM schedules'); }
  calendarTasks(): CalendarTask[] { return this.rows<CalendarTask>('SELECT data FROM calendar_tasks'); }
  putCalendarTask(task: CalendarTask): void {
    const serialized = JSON.stringify(task);
    const old = this.db.prepare('SELECT data FROM calendar_tasks WHERE id=?').get(task.key) as { data: string } | undefined;
    if (old?.data === serialized) return;
    this.db.prepare('INSERT OR REPLACE INTO calendar_tasks VALUES(?,?)').run(task.key, serialized); this.changed();
  }
  removeCalendarTask(key: string): void {
    this.db.prepare('DELETE FROM calendar_tasks WHERE id=?').run(key); this.changed();
  }
  runs(statuses?: RunStatus[]): ScheduleRun[] {
    const filter = statuses?.length ? ` WHERE json_extract(data,'$.status') IN (${statuses.map(() => '?').join(',')})` : '';
    return this.rows<ScheduleRun>(`SELECT data FROM schedule_runs${filter} ORDER BY planned_at DESC`, ...statuses ?? []);
  }
  run(id: string): ScheduleRun | undefined { return this.rows<ScheduleRun>('SELECT data FROM schedule_runs WHERE id=?', id)[0]; }
  recentRuns(workspace: string): ScheduleRun[] {
    return this.rows<ScheduleRun>("SELECT data FROM schedule_runs WHERE workspace=? OR workspace='*' ORDER BY planned_at DESC LIMIT 1000", workspace);
  }
  get notificationPosition(): SchedulerNotificationPosition {
    const row = this.db.prepare("SELECT value FROM scheduler_preferences WHERE key='notification-position'").get() as { value: string } | undefined;
    return row ? schedulerNotificationPosition(row.value) : DEFAULT_SCHEDULER_NOTIFICATION_POSITION;
  }
  set notificationPosition(value: SchedulerNotificationPosition) {
    const position = schedulerNotificationPosition(value);
    if (this.notificationPosition === position) return;
    this.db.prepare("INSERT OR REPLACE INTO scheduler_preferences(key,value) VALUES('notification-position',?)").run(position);
    this.changed();
  }
  get auto(): boolean { return (this.db.prepare('SELECT auto FROM scheduler_settings WHERE id=1').get() as { auto: number }).auto === 1; }
  set auto(value: boolean) {
    if (this.auto === value) return;
    this.db.prepare('UPDATE scheduler_settings SET auto=? WHERE id=1').run(value ? 1 : 0); this.changed();
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true; this.dirty = false;
    let result: T;
    try {
      result = operation(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.inTransaction = false; this.dirty = false; throw error; }
    this.inTransaction = false;
    if (this.dirty) this.changed();
    return result;
  }
  save(workspace: string, input: ScheduleInput, target?: { id: string; revision: number }): Schedule {
    return this.transaction(() => {
      const old = target ? this.schedules().find(schedule => schedule.id === target.id && schedule.workspace === workspace) : null;
      if (target && (!old || old.revision !== target.revision)) throw new Error('This schedule changed. Reload it before saving.');
      if (old?.calendarLink) throw new Error('This task has moved to Apple Calendar or needs its migration checked there.');
      if (old && this.runs(['starting', 'running']).some(run => run.scheduleId.startsWith(`${old.id}:`))) {
        throw new Error('Wait for this task to finish before editing it.');
      }
      const schedule: Schedule = { ...input, id: old?.id ?? randomUUID(), workspace, revision: (old?.revision ?? 0) + 1, nextAt: input.startAt };
      if (old) this.cancelPending(old.id);
      this.putSchedule(schedule);
      return schedule;
    });
  }
  remove(workspace: string, id: string, revision: number): void {
    this.transaction(() => {
      const schedule = this.schedules().find(item => item.id === id && item.workspace === workspace);
      if (!schedule || schedule.revision !== revision) throw new Error('This schedule changed. Reload it before deleting.');
      if (this.runs(['starting', 'running']).some(run => run.scheduleId.startsWith(`${id}:`))) throw new Error('Stop the running task before deleting its schedule.');
      this.cancelPending(id);
      this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
      this.changed();
    });
  }
  private cancelPending(id: string): void {
    for (const run of this.runs(['pending', 'approved', 'missed'])) if (run.scheduleId.startsWith(`${id}:`)) {
      this.putRun({ ...run, status: 'cancelled', finishedAt: new Date().toISOString(), summary: 'Schedule changed or deleted.' });
    }
  }
  putSchedule(schedule: Schedule): void {
    this.db.prepare('INSERT OR REPLACE INTO schedules VALUES(?,?,?)').run(schedule.id, schedule.workspace, JSON.stringify(schedule));
    this.changed();
  }
  insertRun(run: ScheduleRun): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO schedule_runs VALUES(?,?,?,?,?)')
      .run(run.id, run.scheduleId, run.plannedAt, run.workspace, JSON.stringify(run)) as { changes: number | bigint };
    if (Number(result.changes) === 0) return false;
    this.changed(); return true;
  }
  putRun(run: ScheduleRun): void {
    if (JSON.stringify(this.run(run.id)) === JSON.stringify(run)) return;
    this.db.prepare('UPDATE schedule_runs SET workspace=?, data=? WHERE id=?').run(run.workspace, JSON.stringify(run), run.id);
    this.changed();
  }
  claimRun(expected: ScheduleRun, startedAt: string): boolean {
    return this.transaction(() => {
      const current = this.run(expected.id);
      if (!current || !['pending', 'approved', 'missed'].includes(current.status)
        || JSON.stringify(current) !== JSON.stringify(expected)) return false;
      this.putRun({ ...current, status: 'starting', startedAt, finishedAt: null, dismissed: true, summary: '', ownerPid: process.pid });
      return true;
    });
  }
  close(): void { this.db.close(); }
}
