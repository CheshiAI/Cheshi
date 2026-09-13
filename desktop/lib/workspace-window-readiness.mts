export type WorkspaceWindowTheme = 'dark' | 'light';

/** Coordinates native paint, application content, and navigation completion. */
export function createWorkspaceWindowReadiness(options: { signal: AbortSignal; timeoutMs?: number }) {
  let browserReady = false;
  let loaded = false;
  let theme: WorkspaceWindowTheme | null = null;
  let failure: Error | null = null;
  let complete = false;
  let resolveReady!: (theme: WorkspaceWindowTheme) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<WorkspaceWindowTheme>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Events may fail synchronously before the startup caller begins awaiting.
  void ready.catch(() => undefined);
  const timeout = setTimeout(() => fail(new Error('The workspace window did not become ready in time.')), options.timeoutMs ?? 30_000);
  timeout.unref?.();
  function cleanup() {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', aborted);
  }
  function fail(error: unknown) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    cleanup();
    rejectReady(failure);
  }
  function aborted() { fail(new Error('Workspace startup was canceled.')); }
  function checkReady() {
    if (failure || complete || !browserReady || !loaded || !theme) return;
    complete = true;
    cleanup();
    resolveReady(theme);
  }
  options.signal.addEventListener('abort', aborted, { once: true });
  if (options.signal.aborted) aborted();
  return {
    ready,
    fail,
    browserReady() { browserReady = true; checkReady(); },
    rendererReady(value: WorkspaceWindowTheme) { theme = value; checkReady(); },
    loaded() { loaded = true; checkReady(); },
    assertReady() {
      if (failure) throw failure;
      if (!complete || !theme) throw new Error('The workspace window is not ready.');
      return theme;
    },
  };
}
