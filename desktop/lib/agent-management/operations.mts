/** Deletion excludes all in-app worker mutations, while normal independent operations may overlap. */
export function createWorkerOperations() {
  let active = 0, deleting = false;
  const assertAvailable = () => { if (deleting) throw new Error('Worker deletion is in progress. Try again after it finishes.'); };
  return {
    assertAvailable,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertAvailable(); active++;
      try { return await operation(); } finally { active--; }
    },
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
      assertAvailable();
      if (active) throw new Error('A worker operation is in progress. Wait before deleting.');
      deleting = true;
      try { return await operation(); } finally { deleting = false; }
    },
  };
}
export const workerOperations = createWorkerOperations();
