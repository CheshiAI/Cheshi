export interface WorkspaceFileSearchResult {
  files: { path: string; name: string }[];
  truncated: boolean;
}

export function workspaceFileSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0')) {
    throw new TypeError('File search requires a query of at most 256 characters.');
  }
  return value.trim().replaceAll('\\', '/');
}
