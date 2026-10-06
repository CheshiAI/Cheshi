/** Shared by desktop sessions and the packaged specialist runtime. */
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export function parseProjectDocMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1024 || value % 1024 !== 0) {
    throw new TypeError('Enter a positive whole number of KiB.');
  }
  return value;
}

export function projectDocConfigOverride(value = DEFAULT_PROJECT_DOC_MAX_BYTES): string {
  return `project_doc_max_bytes=${parseProjectDocMaxBytes(value)}`;
}
