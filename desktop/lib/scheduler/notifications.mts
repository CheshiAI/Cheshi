import type { SchedulerEngine } from './engine.mts';
import type { ScheduleRun, SchedulerSummary } from '../../shared/scheduler.ts';

export function createSchedulerNotifications(options: {
  engine: SchedulerEngine;
  notify(title: string, body: string, open: () => void): () => void;
  open(run: ScheduleRun): void;
  summary(value: SchedulerSummary): void;
  shouldNotify?(run: ScheduleRun): boolean;
}) {
  const shown = new Set<string>();
  const visible = new Map<string, { key: string; close(): void }>();
  const update = () => {
    const runs = options.engine.allRuns();
    const attention = options.engine.allAttention();
    const waiting = new Set(attention.filter(item => item.approvals.length || item.inputs.length).map(item => item.runId));
    const present = new Set<string>();
    for (const run of runs) {
      const needsInput = waiting.has(run.id);
      if (!needsInput && (run.status !== 'pending' || run.dismissed)) continue;
      if (options.shouldNotify?.(run) === false) continue;
      const item = attention.find(value => value.runId === run.id);
      const key = needsInput ? `${run.id}:${item?.approvals.map(value => value.id)}:${item?.inputs.map(value => value.id)}`
        : `${run.id}:${run.mode}:${run.snapshot?.prompt ?? ''}:${run.workspace}`;
      present.add(run.id);
      if (shown.has(key)) continue;
      shown.add(key); visible.get(run.id)?.close();
      const close = options.notify(needsInput ? 'Task needs your input' : run.kind === 'event' ? 'Upcoming event' : run.mode === 'auto' ? 'Upcoming schedule' : 'Confirm scheduled task',
        `${run.title} · ${new Date(run.plannedAt).toLocaleTimeString()}`, () => options.open(run));
      visible.set(run.id, { key, close });
    }
    for (const [id, notice] of visible) if (!present.has(id)) { notice.close(); visible.delete(id); }
    const future = [
      ...options.engine.store.schedules().filter(item => item.enabled && item.nextAt).map(item => item.nextAt!),
      ...options.engine.store.calendarTasks().filter(item => item.input && !runs.some(run => run.scheduleId === item.key
        && !['pending', 'approved', 'cancelled'].includes(run.status))).map(item => item.event.start),
      ...runs.filter(run => ['pending', 'approved'].includes(run.status)).map(run => run.plannedAt),
    ].filter(time => Date.parse(time) > Date.now()).sort();
    options.summary({ pending: runs.filter(run => run.status === 'pending' && run.mode === 'manual').length + waiting.size,
      running: runs.filter(run => ['starting', 'running'].includes(run.status)).length, next: future[0] ?? null });
  };
  const unsubscribe = options.engine.subscribe(update); update();
  return { dispose() { unsubscribe(); for (const notice of visible.values()) notice.close(); visible.clear(); shown.clear(); } };
}
