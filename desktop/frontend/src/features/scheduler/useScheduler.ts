import { useMemo, useSyncExternalStore } from 'react';
import type { SchedulerApi, SchedulerSnapshot } from '../../../../shared/scheduler';
import { cheshiDesktop } from '../../cheshiDesktop';

const empty: SchedulerSnapshot = { auto: false, schedules: [], runs: [], attention: [], error: '' };
const stores = new WeakMap<SchedulerApi, ReturnType<typeof createSchedulerModel>>();
export function createSchedulerModel(api?: SchedulerApi) {
  let state = empty;
  let unsubscribe: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  let dirty = false;
  let generation = 0;
  let subscriptionError = '';
  let serialized = JSON.stringify(empty);
  const listeners = new Set<() => void>();
  const publish = (next: SchedulerSnapshot) => {
    const value = JSON.stringify(next);
    if (value === serialized) return;
    serialized = value; state = next;
    listeners.forEach(listener => listener());
  };
  const refresh = (): Promise<void> => {
    dirty = true;
    return pending ??= (async () => {
      if (!api) return;
      do {
        dirty = false;
        const reading = generation;
        let next: SchedulerSnapshot;
        try { next = await api.read(); }
        catch (error) { next = { ...state, error: error instanceof Error ? error.message : String(error) }; }
        if (reading === generation && !dirty) publish(subscriptionError ? { ...next, error: subscriptionError } : next);
      } while (dirty);
    })().finally(() => { pending = undefined; });
  };
  return { refresh, getSnapshot: () => state, subscribe(listener: () => void) {
    listeners.add(listener);
    if (!unsubscribe && api) {
      generation++; subscriptionError = '';
      unsubscribe = api.onChanged(() => { void refresh(); }, message => {
        subscriptionError = message; publish({ ...state, error: message });
      });
      void refresh();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; generation++; dirty = false; }
    };
  } };
}
export function useScheduler(api = cheshiDesktop?.scheduler) {
  const model = useMemo(() => {
    if (!api) return createSchedulerModel();
    const existing = stores.get(api); if (existing) return existing;
    const next = createSchedulerModel(api); stores.set(api, next); return next;
  }, [api]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return { api, state, refresh: model.refresh };
}
