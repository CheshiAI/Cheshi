import { UnresolvedApplicationError } from '../../../experiments/codex-specialists/src/application-storage.ts';

/** Deletion excludes all in-app worker mutations, while normal independent operations may overlap. */
export class WorkerOperationBusyError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkerOperationBusyError'; }
}

/** Expected contention and unresolved application state are normal IPC replies; other failures still reject. */
export async function deletionReply<T>(operation: () => Promise<T>) {
  try { return { status: 'deleted' as const, value: await operation() }; }
  catch (error) {
    if (error instanceof WorkerOperationBusyError) return { status: 'busy' as const, message: error.message };
    if (error instanceof UnresolvedApplicationError) return { status: 'blocked' as const, message: error.message };
    throw error;
  }
}

export function createWorkerOperations(waitTimeoutMs = 5000) {
  let active = 0, deleting = false, waiting = false;
  let onIdle: (() => void) | null = null;
  const assertAvailable = () => { if (deleting) throw new WorkerOperationBusyError('Worker deletion is in progress. Try again after it finishes.'); };
  const acquireWhenIdle = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      onIdle = null; waiting = false;
      reject(new WorkerOperationBusyError('Worker operations are still running. Nothing was deleted. Try again shortly.'));
    }, waitTimeoutMs);
    onIdle = () => {
      clearTimeout(timer); onIdle = null; waiting = false;
      // Claim the lock as the last operation exits, before new work can enter.
      deleting = true; resolve();
    };
  });
  return {
    assertAvailable,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertAvailable(); active++;
      try { return await operation(); } finally { if (--active === 0) onIdle?.(); }
    },
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
      assertAvailable();
      if (waiting) throw new WorkerOperationBusyError('A deletion is already waiting for worker operations. Try again after it finishes.');
      if (active) { waiting = true; await acquireWhenIdle(); }
      else deleting = true;
      try { return await operation(); } finally { deleting = false; }
    },
  };
}
export const workerOperations = createWorkerOperations();
