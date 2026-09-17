import type { IpcRenderer } from 'electron';
import { workspaceFileSearchQuery, workspaceFileSearchResult } from '../shared/workspace-file-search.ts';
import { workspaceTextSearchRequest, workspaceTextSearchResult, type WorkspaceTextSearchRequest } from '../shared/workspace-text-search.ts';

export function createWorkspaceFileSearchApi(ipc: Pick<IpcRenderer, 'invoke'>) {
  return {
    async searchWorkspaceFiles(query: string) {
      return workspaceFileSearchResult(await ipc.invoke('cheshi:search-workspace-files', workspaceFileSearchQuery(query)));
    },
    async searchWorkspaceText(request: WorkspaceTextSearchRequest) {
      return workspaceTextSearchResult(await ipc.invoke('cheshi:search-workspace-text', workspaceTextSearchRequest(request)));
    },
  };
}
