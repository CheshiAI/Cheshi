import { useRef, useState } from 'react';
import type { WorkspaceCatalogEntry, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { workspaceError } from './workspace-paths';
import { runWorkspaceOperation, type WorkspaceOperationState } from './workspace-operation';

// Keep the completed operation separate from window opening: retrying must never clone twice.
export function useWorkspaceOperation(api: WorkspaceManagementApi, onOpened: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WorkspaceCatalogEntry | null>(null);
  const state = useRef<WorkspaceOperationState>({ pending: false, completed: null });

  const run = async (operation: () => Promise<WorkspaceCatalogEntry>): Promise<void> => {
    if (state.current.pending) return;
    setBusy(true);
    setError(null);
    try {
      if (await runWorkspaceOperation(state.current, operation, (path) => api.open(path), setCreated)) onOpened();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, created, run };
}
