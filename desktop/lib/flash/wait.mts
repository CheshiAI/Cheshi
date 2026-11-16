import { FlashError } from './client.mts';

/** Cancel this waiter without canceling the shared synchronization. */
export function waitForSync(operation: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(signal.reason ?? new Error('Canceled'));
    const timer = setTimeout(() => finish(new FlashError('sync_timeout',
      'Session memory is still synchronizing. Retry after Flash is ready; this is not an empty search.')), timeoutMs);
    function finish(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(() => finish(), finish);
    if (signal.aborted) abort();
  });
}
