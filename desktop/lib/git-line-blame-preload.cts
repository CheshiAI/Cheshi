import type { IpcRenderer } from 'electron';
import { gitLineBlame, gitLineCommit, gitLineBlameRequest, type GitLineBlameRequest } from '../shared/git-line-blame.ts';

export function createGitLineBlameApi(ipc: Pick<IpcRenderer, 'invoke'>) {
  return { async getGitLineBlame(request: GitLineBlameRequest) {
    return gitLineBlame(await ipc.invoke('cheshi:get-git-line-blame', gitLineBlameRequest(request)));
  }, async getGitLineCommit(request: GitLineBlameRequest) {
    return gitLineCommit(await ipc.invoke('cheshi:get-git-line-commit', gitLineBlameRequest(request)));
  } };
}
