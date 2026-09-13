import type { WorkspaceCatalogEntry } from '../../../../../shared/workspace-management';

export interface WorkspaceOperationState {
  pending: boolean;
  completed: WorkspaceCatalogEntry | null;
}

export async function runWorkspaceOperation(
  state: WorkspaceOperationState,
  create: () => Promise<WorkspaceCatalogEntry>,
  open: (path: string) => Promise<void>,
  onCreated: (entry: WorkspaceCatalogEntry) => void,
): Promise<boolean> {
  if (state.pending) return false;
  state.pending = true;
  try {
    const entry = state.completed ?? await create();
    state.completed = entry;
    onCreated(entry);
    await open(entry.rootPath);
    return true;
  } finally {
    state.pending = false;
  }
}
