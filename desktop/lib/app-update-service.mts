import type { AppRelease, AppUpdateState } from '../shared/app-update.ts';

export const APP_UPDATE_INTERVAL_MS = 60 * 60_000;

export function createAppUpdateService(options: {
  currentVersion: string;
  preview?: boolean;
  check(signal: AbortSignal): Promise<AppRelease | null>;
  install(release: AppRelease, installing: () => void): Promise<void>;
  openExternal(url: string): Promise<void>;
  unavailableReason: string | null;
  now?: () => number;
  intervalMs?: number;
  onCheckError?: (error: unknown) => void;
}) {
  const interval = options.intervalMs ?? APP_UPDATE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const listeners = new Set<(state: AppUpdateState) => void>();
  const controller = new AbortController();
  let state: AppUpdateState = {
    currentVersion: options.currentVersion, release: null, phase: 'idle', error: null,
    ...(options.preview === true ? { preview: true } : {}),
    installUnavailableReason: options.unavailableReason,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastCheck: number | null = null;
  let flight: Promise<void> | null = null;
  let disposed = false;
  let unavailableReason = options.unavailableReason;
  const snapshot = (): AppUpdateState => structuredClone(state);
  const emit = () => { if (!disposed) for (const listener of listeners) listener(snapshot()); };
  const reason = () => options.preview === true ? null : unavailableReason ?? (state.release && !state.release.asset
    ? 'A verified installer for this device is not available yet.' : null);
  const check = (): Promise<void> => {
    if (disposed || state.phase !== 'idle') return Promise.resolve();
    if (flight) return flight;
    lastCheck = now();
    if (timer) schedule();
    flight = Promise.resolve().then(() => options.check(controller.signal)).then(release => {
      if (disposed || state.phase !== 'idle') return;
      state = { ...state, release, error: state.release?.tag === release?.tag ? state.error : null };
      state.installUnavailableReason = reason();
      emit();
    }).catch(error => {
      // A failed check is not evidence that a previously found update disappeared.
      if (!disposed) options.onCheckError?.(error);
    }).finally(() => { flight = null; });
    return flight;
  };
  const checkIfDue = () => lastCheck === null || now() - lastCheck >= interval ? check() : Promise.resolve();
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void checkIfDue(); }, interval);
    timer.unref();
  };
  return {
    snapshot,
    subscribe(listener: (state: AppUpdateState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setUnavailableReason(value: string | null) {
      unavailableReason = value;
      state = { ...state, installUnavailableReason: reason() };
      emit();
    },
    start() {
      if (timer || disposed) return;
      schedule();
      void check();
    },
    resume: checkIfDue,
    async install() {
      if (disposed || state.phase !== 'idle') return;
      const release = state.release;
      if (!release) throw new Error('No update is available.');
      if (state.installUnavailableReason) throw new Error(state.installUnavailableReason);
      state = { ...state, phase: 'downloading', error: null };
      emit();
      try {
        await options.install(release, () => {
          state = { ...state, phase: 'installing' };
          emit();
        });
      } catch (error) {
        state = { ...state, phase: 'idle', error: error instanceof Error ? error.message : 'Update failed. Please try again.' };
        emit();
        throw error;
      }
    },
    async openRelease() { if (state.release) await options.openExternal(state.release.url); },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      controller.abort();
      listeners.clear();
    },
  };
}
