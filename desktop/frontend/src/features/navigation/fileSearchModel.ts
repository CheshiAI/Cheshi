import type { WorkspaceFileSearchResult } from '../../../../shared/workspace-file-search';

export interface FileSearchState {
  query: string;
  result: WorkspaceFileSearchResult;
  loading: boolean;
  error: string | null;
  selectedIndex: number;
}
export const initialFileSearchState: FileSearchState = {
  query: '', result: { files: [], truncated: false }, loading: false, error: null, selectedIndex: -1,
};

export function selectedFileSearchPath(state: FileSearchState): string | null {
  return state.loading || state.error ? null : state.result.files[state.selectedIndex]?.path ?? null;
}

export function handleFileSearchKeyDown(event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'> & {
  nativeEvent: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>;
}, actions: { move: (direction: number) => void; open: () => void; close: () => void }) {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') actions.close();
  else if (event.key === 'Enter') actions.open();
  else actions.move(event.key === 'ArrowDown' ? 1 : -1);
}

export function createFileSearchController(
  search: (query: string) => Promise<WorkspaceFileSearchResult>,
  update: (state: FileSearchState) => void,
  delay = 150,
) {
  let state = initialFileSearchState;
  let revision = 0;
  let disposed = false;
  let inFlight = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: FileSearchState) => { state = next; if (!disposed) update(state); };
  const run = async () => {
    timer = undefined;
    if (disposed || !state.query.trim()) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    queued = false;
    const requested = revision;
    try {
      const result = await search(state.query);
      if (!disposed && requested === revision) {
        publish({ ...state, result, loading: false, selectedIndex: result.files.length ? 0 : -1 });
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
  const changeQuery = (query: string) => {
    if (disposed) return;
    revision++;
    clearTimeout(timer);
    queued = false;
    publish({ ...initialFileSearchState, query, loading: Boolean(query.trim()) });
    if (query.trim()) timer = setTimeout(() => { void run(); }, delay);
  };
  return {
    changeQuery,
    refresh: () => changeQuery(state.query),
    select: (index: number) => {
      if (!disposed && !state.loading && state.result.files[index]) publish({ ...state, selectedIndex: index });
    },
    move: (direction: number) => {
      const count = state.result.files.length;
      if (!disposed && !state.loading && count) {
        publish({ ...state, selectedIndex: (state.selectedIndex + direction + count) % count });
      }
    },
    dispose: () => { disposed = true; revision++; queued = false; clearTimeout(timer); },
  };
}
