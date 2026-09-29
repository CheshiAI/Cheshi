import { randomUUID } from 'node:crypto';
import type { CalendarEvent } from '../../shared/apple-calendar.ts';
import type { Schedule, ScheduleInput, ScheduleRun, SchedulerAction, SchedulerAttention, SchedulerSnapshot } from '../../shared/scheduler.ts';
import { nextScheduleTime } from '../../shared/scheduler-time.ts';
import type { SchedulerStore } from './store.mts';
import { isCalendarTask } from '../../shared/calendar-task.ts';
import { syncCalendarTasks } from './calendar-tasks.mts';
import type { ChatUserInputResponse } from '../../shared/chat-user-input.ts';

export interface SchedulerRunner {
  run(run: ScheduleRun, update: (patch: Partial<ScheduleRun>) => void): Promise<void>;
  cancel(id: string): Promise<void>;
  attention(): SchedulerAttention[];
  subscribe?(listener: () => void): () => void;
  respondApproval?(id: string, request: string, decision: 'accept' | 'decline'): Promise<void>;
  respondInput?(id: string, request: string, response: ChatUserInputResponse): Promise<void>;
}
export type SchedulerTimer = (callback: () => void, delay: number) => () => void;
export const schedulerTimer: SchedulerTimer = (callback, delay) => {
  const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer);
};
const WAITING = new Set(['pending', 'approved']);
const ACTIVE = new Set(['starting', 'running']);
function liveRunOwner(run: ScheduleRun): boolean {
  if (!run.ownerPid || !Number.isSafeInteger(run.ownerPid) || run.ownerPid < 1) return false;
  try { process.kill(run.ownerPid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class SchedulerEngine {
  readonly store: SchedulerStore;
  private readonly now: () => number;
  private readonly runners = new Map<string, Set<SchedulerRunner>>();
  private readonly executing = new Map<string, SchedulerRunner>();
  private cancelWake: (() => void) | undefined;
  private readonly scheduleTimer: SchedulerTimer;
  private started = false;
  private forceMissed = false;
  private readonly calendarEvents = new Map<string, CalendarEvent>();
  private readonly listeners = new Set<() => void>();
  private changedQueued = false;
  private readonly unsubscribeStore: () => void;
  private error = '';
  private stopped = false;
  private suspended = false;
  private calendarReady = false;
  private calendarVersion = 0;
  private fallback: ((workspace: string) => SchedulerRunner) | undefined;
  private readonly reviews = new Map<string, string>();
  private reviewVersion = 0;
  review(workspace: string, id: string): void { this.reviews.set(workspace, id); this.reviewVersion++; this.changed(); }
  setRunnerFactory(factory: (workspace: string) => SchedulerRunner): void { this.fallback = factory; }
  runnerFor(id: string): SchedulerRunner | undefined { return this.executing.get(id); }
  allRuns(): ScheduleRun[] { return this.store.runs(); }
  allAttention(): SchedulerAttention[] { return [...new Set(this.executing.values())].flatMap(runner => runner.attention()); }
  workspaceBusy(workspace: string): boolean { return this.store.runs(['starting', 'running']).some(run => run.workspace === workspace); }
  constructor(store: SchedulerStore, now = Date.now, timer = schedulerTimer) {
    this.store = store; this.now = now; this.scheduleTimer = timer;
    this.unsubscribeStore = store.subscribe(() => this.changed());
    for (const run of store.runs(['starting', 'running', 'pending', 'approved'])) {
      if (ACTIVE.has(run.status) && !liveRunOwner(run)) this.patch(run.id, { status: 'unknown', summary: 'Cheshi restarted during execution. Check the conversation before retrying.', finishedAt: this.iso() });
      else if (WAITING.has(run.status) && Date.parse(run.plannedAt) <= now()) this.patch(run.id, { status: 'missed', summary: 'Cheshi was unavailable at the scheduled time.', finishedAt: this.iso() });
    }
  }
  start(): void {
    if (this.started) return;
    this.started = true; this.tick();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setError(message: string): void { if (this.error !== message) { this.error = message; this.changed(); } }
  private changed(): void {
    if (this.changedQueued || this.stopped) return;
    this.changedQueued = true;
    queueMicrotask(() => {
      this.changedQueued = false;
      if (this.stopped) return;
      this.arm(); this.listeners.forEach(listener => listener());
    });
  }
  private arm(): void {
    this.cancelWake?.(); this.cancelWake = undefined;
    if (!this.started || this.stopped || this.suspended) return;
    const times = [
      ...this.store.schedules().filter(item => item.enabled && item.nextAt).map(item => Date.parse(item.nextAt!) - 300_000),
      ...this.store.runs(['pending', 'approved']).map(run => Date.parse(run.plannedAt)),
      ...[...this.calendarEvents.values()].map(event => Date.parse(event.start) - 300_000),
      ...this.dueCalendarTasks().map(task => Date.parse(task.event.start) - 300_000),
    ];
    if (!times.length) return;
    const delay = Math.min(2_147_483_647, Math.max(0, Math.min(...times) - this.now()));
    this.cancelWake = this.scheduleTimer(() => {
      this.cancelWake = undefined;
      try { this.tick(); }
      catch (error) { this.started = false; this.setError(error instanceof Error ? error.message : String(error)); }
    }, delay);
  }
  register(workspace: string, runner: SchedulerRunner): () => Promise<void> {
    const runners = this.runners.get(workspace) ?? new Set<SchedulerRunner>();
    runners.add(runner); this.runners.set(workspace, runners);
    const unsubscribe = runner.subscribe?.(() => this.changed());
    return async () => {
      runners.delete(runner);
      unsubscribe?.(); this.changed();
      for (const [id, owner] of this.executing) if (owner === runner) await owner.cancel(id);
    };
  }
  snapshot(workspace: string): SchedulerSnapshot {
    const runs = new Map(this.store.recentRuns(workspace).map(run => [run.id, run]));
    for (const run of this.store.runs(['starting', 'running', 'pending', 'approved'])) {
      if (run.workspace === workspace || run.workspace === '*') runs.set(run.id, run);
    }
    return { auto: this.store.auto, notificationPosition: this.store.notificationPosition, schedules: this.store.schedules().filter(item => item.workspace === workspace),
      runs: [...runs.values()].sort((a, b) => b.plannedAt.localeCompare(a.plannedAt)),
      attention: [...new Set([...(this.runners.get(workspace) ?? []), ...this.executing.values()])].flatMap(runner => runner.attention())
        .filter(item => runs.has(item.runId)), error: this.error,
      calendarTasks: this.store.calendarTasks().filter(item => item.workspace === workspace || item.workspace === '*'),
      reviewId: this.reviews.get(workspace) ?? null, reviewVersion: this.reviewVersion, calendarVersion: this.calendarVersion };
  }
  save(workspace: string, input: ScheduleInput, target?: { id: string; revision: number }): Schedule {
    if (Date.parse(input.startAt) <= this.now() && input.enabled) throw new Error('Choose a future start time.');
    const schedule = this.store.save(workspace, input, target);
    this.tick(); return schedule;
  }
  setAuto(enabled: boolean): void {
    this.store.auto = enabled;
    // A preference change must never authorize an already presented occurrence.
    for (const run of this.store.runs(['pending'])) {
      if (!enabled && run.mode === 'auto') this.patch(run.id, { mode: 'manual', dismissed: false });
      else if (enabled && run.kind === 'event') this.patch(run.id, { mode: 'auto' });
    }
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private patch(id: string, patch: Partial<ScheduleRun>): void {
    const current = this.store.run(id);
    if (current) this.store.putRun({ ...current, ...patch, id: current.id });
  }
  private newRun(scheduleId: string, workspace: string, title: string, plannedAt: string, snapshot: ScheduleInput | null): ScheduleRun {
    return { id: randomUUID(), scheduleId, workspace, title, plannedAt, snapshot, kind: snapshot ? 'task' : 'event',
      status: 'pending', mode: this.store.auto ? 'auto' : 'manual', approvedAt: null, dismissed: false,
      startedAt: null, finishedAt: null, profileId: null, threadId: null, turnId: null, summary: '' };
  }
  suspend(): void { this.suspended = true; this.cancelWake?.(); this.cancelWake = undefined; }
  resume(): void { this.suspended = false; this.forceMissed = true; this.tick(); }
  invalidateCalendar(): void { this.calendarReady = false; this.calendarEvents.clear(); this.arm(); }
  private dueCalendarTasks() {
    if (!this.calendarReady) return [];
    const recorded = this.store.runs();
    return this.store.calendarTasks().filter(task => task.input && !recorded.some(run => run.scheduleId === task.key
      && (['starting', 'running', 'completed', 'failed', 'unknown'].includes(run.status)
        || (run.plannedAt === task.event.start && run.status !== 'cancelled'))));
  }
  tick(): void {
    if (this.stopped || this.suspended) return;
    const now = this.now();
    const interrupted = this.forceMissed; this.forceMissed = false;
    for (const task of this.dueCalendarTasks()) {
      if (Date.parse(task.event.start) > now + 300_000) continue;
      const run = this.newRun(task.key, task.workspace, task.input!.title, task.event.start, task.input);
      if (Date.parse(run.plannedAt) <= now) { run.status = 'missed'; run.finishedAt = this.iso(); run.summary = 'Scheduled time passed while unavailable.'; }
      const previous = this.store.runs().find(item => item.scheduleId === task.key && item.plannedAt === task.event.start);
      if (previous?.status === 'cancelled') this.store.putRun({ ...run, id: previous.id });
      else this.store.insertRun(run);
    }
    for (const [key, event] of this.calendarEvents) {
      if (Date.parse(event.start) > now + 300_000) continue;
      this.store.insertRun(this.newRun(key, '*', event.title, event.start, null));
      this.calendarEvents.delete(key);
    }
    for (const schedule of this.store.schedules()) {
      if (!schedule.enabled || !schedule.nextAt || Date.parse(schedule.nextAt) > now + 300_000) continue;
      const run = this.newRun(`${schedule.id}:${schedule.revision}`, schedule.workspace, schedule.title, schedule.nextAt, schedule);
      if (Date.parse(run.plannedAt) < now) {
        run.status = 'missed'; run.finishedAt = this.iso();
        run.summary = 'Scheduled time passed while unavailable. Later overdue repetitions were also skipped.';
      }
      this.store.transaction(() => {
        this.store.insertRun(run);
        this.store.putSchedule({ ...schedule, nextAt: nextScheduleTime(schedule, Math.max(now, Date.parse(run.plannedAt))) });
      });
    }
    for (const run of this.store.runs(['pending', 'approved'])) {
      if (!WAITING.has(run.status) || Date.parse(run.plannedAt) > now) continue;
      if (run.scheduleId.startsWith('apple:') && !this.calendarReady) {
        this.patch(run.id, { status: 'missed', finishedAt: this.iso(), summary: 'Calendar task could not be verified before execution.' }); continue;
      }
      if (interrupted || now - Date.parse(run.plannedAt) > 15_000) {
        this.patch(run.id, { status: 'missed', finishedAt: this.iso(), summary: 'Cheshi missed the scheduled time.' }); continue;
      }
      if (run.kind === 'event') {
        this.patch(run.id, { status: 'missed', finishedAt: this.iso(), summary: 'Event reminder was not acknowledged.' }); continue;
      }
      if (run.status !== 'approved' && run.mode !== 'auto') {
        this.patch(run.id, { status: 'skipped', finishedAt: this.iso(), summary: 'No approval before the scheduled time.' }); continue;
      }
      this.dispatch(run);
    }
    this.arm();
  }
  private dispatch(run: ScheduleRun): void {
    const runner = this.fallback?.(run.workspace) ?? [...(this.runners.get(run.workspace) ?? [])][0];
    if (!runner || [...this.executing.values()].includes(runner)) {
      this.patch(run.id, { status: 'missed', finishedAt: this.iso(), summary: runner ? 'Another scheduled task is still running.' : 'Open this workspace to run the task.' }); return;
    }
    if (!this.store.claimRun(run, this.iso())) return;
    this.executing.set(run.id, runner);
    const unsubscribe = runner.subscribe?.(() => this.changed());
    void runner.run(run, patch => this.patch(run.id, patch)).catch((error: unknown) => {
      this.patch(run.id, { status: 'unknown', summary: error instanceof Error ? error.message : String(error), finishedAt: this.iso() });
    }).finally(() => { unsubscribe?.(); this.executing.delete(run.id); this.changed(); });
  }
  async act(workspace: string, id: string, action: SchedulerAction): Promise<void> {
    const run = this.store.run(id);
    if (!run || (run.workspace !== workspace && run.workspace !== '*')) throw new Error('This occurrence is no longer available.');
    if (action === 'dismiss') { this.patch(id, { dismissed: true }); return; }
    if (action === 'cancel' && ACTIVE.has(run.status)) { await this.executing.get(id)?.cancel(id); return; }
    if (action === 'run-late' && run.status === 'missed' && run.kind === 'task') {
      const schedule = this.store.schedules().find(item => `${item.id}:${item.revision}` === run.scheduleId && item.enabled);
      const calendarTask = this.calendarReady && this.store.calendarTasks().find(task => task.key === run.scheduleId && task.input
        && task.event.start === run.plannedAt && JSON.stringify(task.input) === JSON.stringify(run.snapshot));
      if (!schedule && !calendarTask) throw new Error('The schedule has changed or is disabled.');
      this.patch(id, { approvedAt: this.iso(), mode: 'manual' });
      this.dispatch(this.store.run(id)!); return;
    }
    if (!WAITING.has(run.status) || Date.parse(run.plannedAt) <= this.now()) throw new Error('The confirmation period has ended.');
    if (action === 'approve' && run.scheduleId.startsWith('apple:') && !this.calendarReady) throw new Error('Wait for Apple Calendar to refresh before approving this task.');
    if (action === 'approve' && run.kind === 'task') this.patch(id, { status: 'approved', approvedAt: this.iso(), mode: 'manual', dismissed: true });
    else if (action === 'skip') this.patch(id, { status: 'skipped', finishedAt: this.iso(), dismissed: true });
    else if (action === 'acknowledge' && run.kind === 'event') this.patch(id, { status: 'acknowledged', finishedAt: this.iso(), dismissed: true });
    else throw new Error('This action does not apply to this occurrence.');
  }
  syncEvents(events: CalendarEvent[], start: number, end: number): void {
    syncCalendarTasks(this.store, events, start, end, this.now());
    this.calendarReady = true;
    this.calendarVersion++; this.changed();
    const eligible = events.filter(event => !isCalendarTask(event.title) && !event.allDay && Date.parse(event.start) >= start && Date.parse(event.start) < end);
    const keys = new Set(eligible.map(event => `${event.calendarId}:${event.id}:${event.start}`));
    this.calendarEvents.clear();
    for (const run of this.store.runs(['pending'])) {
      if (run.kind === 'event' && run.status === 'pending' && Date.parse(run.plannedAt) >= start && Date.parse(run.plannedAt) < end
        && !keys.has(run.scheduleId)) this.patch(run.id, { status: 'cancelled', finishedAt: this.iso(), summary: 'Event moved or removed.' });
    }
    for (const event of eligible) this.calendarEvents.set(`${event.calendarId}:${event.id}:${event.start}`, event);
    this.tick();
  }
  async stop(): Promise<void> {
    this.stopped = true; this.cancelWake?.(); this.unsubscribeStore(); this.listeners.clear();
    await Promise.all([...this.executing].map(([id, runner]) => runner.cancel(id)));
  }
}
