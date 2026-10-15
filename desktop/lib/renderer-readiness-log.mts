/** Per-window load timing. Repeated ready/theme notifications do not start a new load. */
export function createRendererReadinessLog(options: {
  enabled: boolean;
  write(message: string): void;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  let startedAt = now();
  let waiting = true;
  let initial = true;
  return {
    navigationStarted(isInPlace: boolean, isMainFrame: boolean) {
      if (isMainFrame !== true || isInPlace === true) return;
      startedAt = now();
      waiting = true;
    },
    ready() {
      if (!waiting) return;
      if (options.enabled) options.write(`[cheshi] ${initial ? 'Startup renderer ready' : 'Renderer reload ready'}: ${Math.max(0, Math.round(now() - startedAt))} ms\n`);
      waiting = false;
      initial = false;
    },
  };
}
