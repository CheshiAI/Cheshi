export interface WorkspaceDiskUsage {
  /** Allocated blocks in the workspace on its own volume, including hidden files. */
  workspaceBytes: number;
  /** Total capacity of that volume, not necessarily the machine's internal SSD. */
  totalBytes: number;
  /** Unix timestamp in milliseconds when the measurement completed. */
  measuredAt: number;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function workspaceDiskUsage(value: unknown): WorkspaceDiskUsage {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  if (!record || !nonnegativeInteger(record.workspaceBytes) || !nonnegativeInteger(record.totalBytes)
    || record.totalBytes === 0 || !nonnegativeInteger(record.measuredAt)) {
    throw new TypeError('Invalid workspace disk usage response.');
  }
  return { workspaceBytes: record.workspaceBytes, totalBytes: record.totalBytes, measuredAt: record.measuredAt };
}
