import path from 'node:path';
import { AppleCalendarService } from '../apple-calendar-service.mts';
import { openSchedulerStore } from './store.mts';
import { SchedulerEngine } from './engine.mts';
import { createSchedulerCalendar } from './calendar.mts';
import { watchAppleCalendar } from '../apple-calendar-watch.mts';
import { onAppleCalendarChanged } from '../apple-calendar-changes.mts';
import { createBackgroundScheduler, type BackgroundOptions } from './background.mts';

let shared: Promise<SchedulerEngine> | undefined;
let calendar: ReturnType<typeof createSchedulerCalendar> | undefined;
let watcher: ReturnType<typeof watchAppleCalendar> | undefined;
let unsubscribe: (() => void) | undefined;
let background: ReturnType<typeof createBackgroundScheduler> | undefined;
export async function startScheduler(options: BackgroundOptions): Promise<SchedulerEngine> {
  background ??= createBackgroundScheduler(options);
  const engine = await getScheduler(options.userDataDirectory);
  engine.setRunnerFactory(background.get); return engine;
}
export function suspendScheduler(): void {
  calendar?.suspend();
  void shared?.then(engine => engine.suspend()).catch(error => console.warn('[cheshi:scheduler]', String(error)));
}
export function resumeScheduler(): void {
  void calendar?.resume();
  void shared?.then(engine => engine.resume()).catch(error => console.warn('[cheshi:scheduler]', String(error)));
}
export function getScheduler(dataDirectory: string): Promise<SchedulerEngine> {
  return shared ??= openSchedulerStore(path.join(dataDirectory, 'scheduler', 'scheduler.sqlite')).then(store => {
    const engine = new SchedulerEngine(store);
    if (background) engine.setRunnerFactory(background.get);
    engine.start();
    if (process.platform === 'darwin') {
      let watchError = ''; let readError = '';
      const showError = () => engine.setError([watchError, readError].filter(Boolean).join(' '));
      calendar = createSchedulerCalendar({ calendar: new AppleCalendarService(), engine,
        error(message) { readError = message; showError(); } });
      const refresh = () => { void calendar?.refresh(); };
      unsubscribe = onAppleCalendarChanged(refresh);
      watcher = watchAppleCalendar({ changed: refresh, clockChanged: resumeScheduler,
        error(message) { watchError = message; showError(); } });
    }
    return engine;
  });
}
export async function stopScheduler(): Promise<void> {
  const engine = await shared;
  if (!engine) return;
  engine.suspend(); calendar?.suspend();
  unsubscribe?.(); unsubscribe = undefined;
  await watcher?.stop(); watcher = undefined;
  await calendar?.stop(); calendar = undefined;
  await engine.stop(); engine.store.close(); shared = undefined; background = undefined;
}
