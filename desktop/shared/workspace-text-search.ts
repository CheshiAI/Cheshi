export interface WorkspaceTextSearchRequest {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  limit?: number;
}
export interface WorkspaceTextSearchMatch { path: string; line: number; column: number; length: number; text: string }
export interface WorkspaceTextSearchResult { matches: WorkspaceTextSearchMatch[]; searchedFiles: number; truncated: boolean }

export const workspaceTextSearchQueryLimit = 500;
export const workspaceTextSearchMatchLimit = 2_000;
export const workspaceTextSearchMaxMatchLimit = 5_000;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function workspaceTextSearchRequest(value: unknown): WorkspaceTextSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Text search request must be an object.');
  const { query, caseSensitive, regex, limit } = value as Record<string, unknown>;
  if (typeof query !== 'string' || query.length < 1 || query.length > workspaceTextSearchQueryLimit || query.includes('\0')) {
    throw new TypeError(`Text search must be text of 1 to ${workspaceTextSearchQueryLimit} characters.`);
  }
  for (const flag of [caseSensitive, regex]) {
    if (flag !== undefined && typeof flag !== 'boolean') throw new TypeError('Text search options must be booleans.');
  }
  if (limit !== undefined && (!isPositiveInteger(limit) || limit > workspaceTextSearchMaxMatchLimit)) {
    throw new TypeError(`Text search limit must be an integer between 1 and ${workspaceTextSearchMaxMatchLimit}.`);
  }
  return { query, caseSensitive: caseSensitive === true, regex: regex === true, limit: limit ?? workspaceTextSearchMatchLimit };
}

export function workspaceTextSearchResult(value: unknown): WorkspaceTextSearchResult {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid text search response.');
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.matches) || result.matches.length > workspaceTextSearchMaxMatchLimit
    || typeof result.searchedFiles !== 'number' || !Number.isSafeInteger(result.searchedFiles) || result.searchedFiles < 0
    || (result.truncated !== true && result.truncated !== false)) throw new TypeError('Invalid text search response.');
  const matches = result.matches.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('Invalid text search match.');
    const match = entry as Record<string, unknown>;
    if (typeof match.path !== 'string' || match.path.length === 0 || match.path.includes('\0') || match.path.startsWith('/')
      || match.path.split('/').some(part => part === '' || part === '.' || part === '..')
      || !isPositiveInteger(match.line) || !isPositiveInteger(match.column) || !isPositiveInteger(match.length)
      || typeof match.text !== 'string') throw new TypeError('Invalid text search match.');
    return { path: match.path, line: match.line, column: match.column, length: match.length, text: match.text };
  });
  return { matches, searchedFiles: result.searchedFiles, truncated: result.truncated };
}
