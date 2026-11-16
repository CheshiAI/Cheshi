/** Coalesce invalidations without dropping events received during an in-flight reconciliation. */
export function createEventQueue<K>(run: (key: K) => Promise<void>, failed: (error: unknown) => void) {
  const pending = new Set<K>();
  let started = false, disposed = false, flight: Promise<void> | null = null;
  function drain(): Promise<void> {
    if (flight) return flight;
    flight = Promise.resolve().then(async () => {
      while (started && !disposed && pending.size) {
        const key = pending.values().next().value!; pending.delete(key);
        try { await run(key); } catch (error) { failed(error); }
      }
    }).finally(() => {
      flight = null;
      if (started && !disposed && pending.size) void drain();
    });
    return flight;
  }
  return {
    notify(key: K) { if (!disposed) { pending.add(key); if (started) void drain(); } },
    start() { if (!disposed) { started = true; void drain(); } },
    async settled() { while (flight) await flight; },
    async dispose() { disposed = true; pending.clear(); await flight; },
  };
}
