import { spyOn } from 'bun:test';
import { act } from 'react';

/** Exercise the runtime's installed interval without waiting ten real seconds. */
export async function withRuntimePolling(run: (poll: () => Promise<void>) => Promise<void>) {
  const intervals = spyOn(globalThis, 'setInterval');
  try {
    await run(async () => {
      const callback = [...intervals.mock.calls].reverse().find(call => call[1] === 10_000)?.[0];
      if (typeof callback !== 'function') throw new Error('Runtime polling interval is missing.');
      await act(async () => { callback(); });
    });
  } finally {
    intervals.mockRestore();
  }
}
