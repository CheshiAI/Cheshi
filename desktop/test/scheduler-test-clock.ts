export function createSchedulerTestClock(initial = Date.parse('2026-09-29T09:00:00Z')) {
  let time = initial;
  const timers = new Map<() => void, number>();
  const now = () => time;
  const schedule = (callback: () => void, delay: number) => {
    timers.set(callback, time + delay); return () => { timers.delete(callback); };
  };
  return { now, schedule, timers,
    async advance(milliseconds: number) {
      const end = time + milliseconds;
      let calls = 0;
      while (true) {
        const next = [...timers].filter(([, at]) => at <= end).sort((a, b) => a[1] - b[1])[0];
        if (!next) break;
        if (++calls > 100) throw new Error('Unexpected timer loop');
        time = next[1]; timers.delete(next[0]); next[0]();
        await Promise.resolve(); await Promise.resolve();
      }
      time = end; await Promise.resolve();
    },
    jump(milliseconds: number) { time += milliseconds; },
  };
}
export function createSchedulerDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
