import type { WorkspaceCodexLoginState, WorkspaceToolStatus } from '../shared/workspace-management.ts';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { codeGraphStorageDirectory, readWorkspaceRegistry } from '../../config/workspace-storage.mts';
import { hasReadyCodeGraphIndex } from './codegraph-initial-index.mts';

/** Resolve a restorable project without registering or indexing an implicit cwd. */
export function resolveStartupWorkspace(options: {
  dataRoot: string;
  workspaceRoot?: string;
  fallbackRoot?: string;
}): string | null {
  const readyRoot = (candidate: string | undefined): string | null => {
    if (!candidate || !path.isAbsolute(candidate)) return null;
    try {
      const root = realpathSync.native(candidate);
      if (root === path.parse(root).root || !statSync(root).isDirectory()) return null;
      return hasReadyCodeGraphIndex(path.join(codeGraphStorageDirectory(options.dataRoot, root), 'codegraph.db')) ? root : null;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  };
  if (options.workspaceRoot?.trim()) return readyRoot(options.workspaceRoot.trim());
  const fallback = readyRoot(options.fallbackRoot);
  if (fallback) return fallback;
  const registry = readWorkspaceRegistry(options.dataRoot);
  const entries = [...registry.workspaces].sort((first, second) => second.lastOpenedAt.localeCompare(first.lastOpenedAt));
  const candidates = [registry.workspaces.find((entry) => entry.id === registry.currentWorkspaceId), ...entries];
  for (const entry of candidates) {
    const root = readyRoot(entry?.rootPath);
    if (root) return root;
  }
  return null;
}

/** Restore a saved project only after its tools and account have been checked. */
export async function canRestoreStartupWorkspace(options: {
  getToolStatus(): WorkspaceToolStatus;
  createLogin(): { getStatus(): Promise<WorkspaceCodexLoginState>; dispose(): Promise<void> };
}): Promise<boolean> {
  const tools = options.getToolStatus();
  if (tools.codex !== true || (tools.platform === 'darwin' && tools.gh !== true)) return false;
  const login = options.createLogin();
  try {
    return (await login.getStatus()).state === 'signed_in';
  } catch {
    // The manager supplies the appropriate error and retry screen.
    return false;
  } finally {
    await login.dispose();
  }
}
