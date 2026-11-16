import type { IpcRenderer } from 'electron';
import { workspaceFileSearchQuery, workspaceFileSearchResult } from '../shared/workspace-file-search.ts';

export function createWorkspaceFileSearchApi(ipc: Pick<IpcRenderer, 'invoke'>, allowProjectPaths = false) {
  return {
    async searchWorkspaceFiles(query: string) {
      return workspaceFileSearchResult(await ipc.invoke('cheshi:search-workspace-files', workspaceFileSearchQuery(query)), allowProjectPaths);
    },
  };
}
