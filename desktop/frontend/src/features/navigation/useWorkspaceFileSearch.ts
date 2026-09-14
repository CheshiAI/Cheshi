import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceFileSearchResult } from '../../../../shared/workspace-file-search';

interface SearchState extends WorkspaceFileSearchResult {
  query: string;
  loading: boolean;
  error: string | null;
}

export function useWorkspaceFileSearch(query: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SearchState>({ query, files: [], truncated: false, loading: true, error: null });
  useEffect(() => {
    let active = true;
    setState({ query, files: [], truncated: false, loading: true, error: null });
    const timer = window.setTimeout(() => {
      const search = cheshiDesktop?.searchWorkspaceFiles;
      if (!search) {
        setState({ query, files: [], truncated: false, loading: false, error: 'Restart Cheshi to enable file search.' });
        return;
      }
      void Promise.resolve().then(() => search(query)).then(result => {
        if (active) setState({ ...result, query, loading: false, error: null });
      }).catch((error: unknown) => {
        if (active) setState({ query, files: [], truncated: false, loading: false,
          error: error instanceof Error ? error.message : 'Could not search workspace files.' });
      });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, revision]);
  return {
    ...(state.query === query ? state : { query, files: [], truncated: false, loading: true, error: null }),
    retry: () => setRevision(value => value + 1),
  };
}
