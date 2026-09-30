import { appleNoteSummary, appleNotesFolders, type AppleNoteSummary, type AppleNotesFolder } from './apple-notes.ts';

export interface NotesSearchRequest { query: string; offset?: number; version?: string; refresh?: boolean }
export interface NotesSearchHit extends AppleNoteSummary { folderId: string; snippet?: string }
export interface NotesSearchStatus {
  state: 'idle' | 'building' | 'updating' | 'ready' | 'error'; completed: number; pending: number; error: string | null;
}
export interface NotesSearchResponse extends NotesSearchStatus {
  hits: NotesSearchHit[]; folders: AppleNotesFolder[]; total: number; nextOffset: number | null; version: string;
}
const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function notesSearchStatus(value: unknown): NotesSearchStatus {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid note search status.');
  const row = value as NotesSearchStatus;
  if (!['idle', 'building', 'updating', 'ready', 'error'].includes(row.state) || !count(row.completed) || !count(row.pending)
    || (row.error !== null && typeof row.error !== 'string')) throw new TypeError('Invalid note search status.');
  return { state: row.state, completed: row.completed, pending: row.pending, error: row.error };
}
export function notesSearchRequest(value: unknown): Required<NotesSearchRequest> {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid note search.');
  const input = value as Record<string, unknown>;
  if (typeof input.query !== 'string' || input.query.length > 500 || input.query.includes('\0')) throw new TypeError('Invalid note search query.');
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || typeof offset !== 'number' || offset < 0) throw new TypeError('Invalid note search offset.');
  if (input.version !== undefined && typeof input.version !== 'string') throw new TypeError('Invalid note search version.');
  if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new TypeError('Invalid note search refresh.');
  return { query: input.query.trim(), offset, version: (input.version as string | undefined) ?? '', refresh: input.refresh === true };
}
export function notesSearchResponse(value: unknown): NotesSearchResponse {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid note search response.');
  const row = value as NotesSearchResponse;
  const status = notesSearchStatus(value);
  if (!Array.isArray(row.hits) || row.hits.length > 100 || !count(row.total)
    || (row.nextOffset !== null && !count(row.nextOffset)) || typeof row.version !== 'string') {
    throw new TypeError('Invalid note search response.');
  }
  return { ...row, ...status, folders: appleNotesFolders(row.folders), hits: row.hits.map(hit => {
    const note = appleNoteSummary(hit);
    if (typeof hit.folderId !== 'string' || !hit.folderId || (hit.snippet !== undefined && (typeof hit.snippet !== 'string' || hit.snippet.length > 400))) {
      throw new TypeError('Invalid note search hit.');
    }
    return { ...note, folderId: hit.folderId, ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }) };
  }) };
}
