import { absoluteProjectPath } from '../shared/workspace-projects.ts';
import type { IpcRenderer } from 'electron';
import { gitLineBlame, gitLineCommit, gitLineBlameRequest, type GitLineBlameRequest } from '../shared/git-line-blame.ts';

function projectBlameRequest(request: GitLineBlameRequest): GitLineBlameRequest {
  if (!request || typeof request.path !== 'string' || !absoluteProjectPath(request.path)) return gitLineBlameRequest(request);
  gitLineBlameRequest({ ...request, path: request.path.replace(/^(?:[A-Za-z]:)?\//u, '') });
  return request;
}

export function createGitLineBlameApi(ipc: Pick<IpcRenderer, 'invoke'>) {
  return { async getGitLineBlame(request: GitLineBlameRequest) {
    return gitLineBlame(await ipc.invoke('cheshi:get-git-line-blame', projectBlameRequest(request)));
  }, async getGitLineCommit(request: GitLineBlameRequest) {
    return gitLineCommit(await ipc.invoke('cheshi:get-git-line-commit', projectBlameRequest(request)));
  } };
}
