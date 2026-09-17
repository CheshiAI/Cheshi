import type { WorkspaceTextSearchMatch, WorkspaceTextSearchRequest, WorkspaceTextSearchResult } from '../../../../shared/workspace-text-search';

export interface TextSearchOptions { caseSensitive: boolean; regex: boolean }
export interface TextSearchState {
  query: string;
  options: TextSearchOptions;
  result: WorkspaceTextSearchResult | null;
  loading: boolean;
  error: string | null;
  selectedIndex: number;
}
export const initialTextSearchState: TextSearchState = {
  query: '', options: { caseSensitive: false, regex: false }, result: null, loading: false, error: null, selectedIndex: -1,
};

export function textSearchMatches(state: TextSearchState): WorkspaceTextSearchMatch[] {
  return state.result?.matches ?? [];
}

export function selectedTextSearchMatch(state: TextSearchState): WorkspaceTextSearchMatch | null {
  return state.loading || state.error ? null : textSearchMatches(state)[state.selectedIndex] ?? null;
}

export function matchLineParts(match: Pick<WorkspaceTextSearchMatch, 'text' | 'column' | 'length'>) {
  const trimmed = match.text.trimStart();
  const removed = match.text.length - trimmed.length;
  const start = Math.max(match.column - 1 - removed, 0);
  const end = Math.min(start + match.length, trimmed.length);
  return { before: trimmed.slice(0, start), matched: trimmed.slice(start, end), after: trimmed.slice(end) };
}

export function textSearchStatus(state: TextSearchState): string {
  if (state.error) return state.error;
  if (state.loading) return 'Searching…';
  if (!state.query.trim() || !state.result) return 'Type text to search workspace files.';
  const { matches, searchedFiles, truncated } = state.result;
  if (matches.length === 0) return `No matches in ${searchedFiles} files.`;
  const files = new Set(matches.map(match => match.path)).size;
  return `${matches.length}${truncated ? '+' : ''} matches in ${files} files · ${searchedFiles} files searched`
    + (truncated ? ' · Showing partial results. Refine your search.' : '');
}

export function createTextSearchController(
  search: (request: WorkspaceTextSearchRequest) => Promise<WorkspaceTextSearchResult>,
  update: (state: TextSearchState) => void,
  delay = 250,
) {
  let state = initialTextSearchState;
  let revision = 0;
  let disposed = false;
  let inFlight = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: TextSearchState) => { state = next; if (!disposed) update(state); };
  const run = async () => {
    timer = undefined;
    if (disposed || !state.query.trim()) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    queued = false;
    const requested = revision;
    try {
      const result = await search({ query: state.query, ...state.options });
      if (!disposed && requested === revision) {
        publish({ ...state, result, loading: false, selectedIndex: result.matches.length ? 0 : -1 });
      }
    } catch (error) {
      if (!disposed && requested === revision) {
        publish({ ...state, loading: false, error: error instanceof Error ? error.message : 'Could not search files.' });
      }
    } finally {
      inFlight = false;
      if (queued && !disposed) { queued = false; void run(); }
    }
  };
  const restart = (query: string, options: TextSearchOptions) => {
    if (disposed) return;
    revision++;
    clearTimeout(timer);
    queued = false;
    publish({ ...initialTextSearchState, query, options, loading: Boolean(query.trim()) });
    if (query.trim()) timer = setTimeout(() => { void run(); }, delay);
  };
  return {
    changeQuery: (query: string) => restart(query, state.options),
    changeOptions: (options: Partial<TextSearchOptions>) => restart(state.query, { ...state.options, ...options }),
    select: (index: number) => {
      if (!disposed && !state.loading && textSearchMatches(state)[index]) publish({ ...state, selectedIndex: index });
    },
    move: (direction: number) => {
      const count = textSearchMatches(state).length;
      if (!disposed && !state.loading && count) {
        publish({ ...state, selectedIndex: (state.selectedIndex + direction + count) % count });
      }
    },
    dispose: () => { disposed = true; revision++; queued = false; clearTimeout(timer); },
  };
}
