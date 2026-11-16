export const TASK_OUTPUT_MAX_BYTES = 1024 * 1024 * 1024;
// Restored deliverables share /tmp with atomic writes and command scratch.
// This is a ceiling, not preallocated memory; the container memory limit still applies.
export const WORKER_TMPFS_BYTES = TASK_OUTPUT_MAX_BYTES * 2;
