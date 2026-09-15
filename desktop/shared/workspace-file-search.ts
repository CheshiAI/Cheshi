export interface WorkspaceFileSearchEntry { path: string; name: string }
export interface WorkspaceFileSearchResult { files: WorkspaceFileSearchEntry[]; truncated: boolean }
export const workspaceFileSearchLimit = 100;

export function workspaceFileSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0')) {
    throw new TypeError('File search must be text of at most 256 characters.');
  }
  return value.trim();
}

export function isSearchableWorkspacePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && !value.includes('\\') && !/^[A-Za-z]:/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

export function workspaceFileSearchResult(value: unknown): WorkspaceFileSearchResult {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid file search response.');
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.files) || result.files.length > workspaceFileSearchLimit
    || (result.truncated !== true && result.truncated !== false)) throw new TypeError('Invalid file search response.');
  const files = result.files.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('Invalid file search entry.');
    const file = entry as Record<string, unknown>;
    if (!isSearchableWorkspacePath(file.path) || file.name !== file.path.split('/').at(-1)) {
      throw new TypeError('Invalid file search entry.');
    }
    return { path: file.path, name: file.name as string };
  });
  return { files, truncated: result.truncated };
}
