import { readGitLineBlame, readGitLineCommit } from './git-line-blame.mts';
import { listGitHubIssues, readGitHubIssue, readGitHubIssueComments, gitHubIssueUrl } from './github-issue-service.mts';
import type { IpcMain, IpcMainInvokeEvent, Shell } from 'electron';
import type { GitService } from './git-service.mts';

interface GitIpcContext {
  ipcMain: Pick<IpcMain, 'handle'>;
  gitService: GitService;
  assertCheshiSender(event: IpcMainInvokeEvent): void;
  shell: Pick<Shell, 'openExternal' | 'trashItem'>;
}

export function registerGitIpcHandlers({
  ipcMain,
  gitService,
  assertCheshiSender,
  shell,
}: GitIpcContext) {
  ipcMain.handle('cheshi:list-github-issues', (event, query) => {
    assertCheshiSender(event);
    return listGitHubIssues(gitService, query);
  });
  ipcMain.handle('cheshi:read-github-issue', (event, number) => {
    assertCheshiSender(event);
    return readGitHubIssue(gitService, number);
  });
  ipcMain.handle('cheshi:read-github-issue-comments', (event, number, page) => {
    assertCheshiSender(event);
    return readGitHubIssueComments(gitService, number, page);
  });
  ipcMain.handle('cheshi:open-github-issue', async (event, number) => {
    assertCheshiSender(event);
    await shell.openExternal(await gitHubIssueUrl(gitService, number));
  });
  ipcMain.handle('cheshi:get-git-snapshot', (event) => {
    assertCheshiSender(event);
    return gitService.getSnapshot();
  });
  ipcMain.handle('cheshi:get-git-branch-commits', (event, branchReference) => {
    assertCheshiSender(event);
    return gitService.getBranchCommits(branchReference);
  });
  ipcMain.handle('cheshi:get-git-line-blame', (event, request) => {
    assertCheshiSender(event);
    return readGitLineBlame(gitService, request);
  });
  ipcMain.handle('cheshi:get-git-line-commit', (event, request) => {
    assertCheshiSender(event);
    return readGitLineCommit(gitService, request);
  });
  ipcMain.handle('cheshi:get-git-diff', (event, request) => {
    assertCheshiSender(event);
    return gitService.getDiff(request);
  });
  ipcMain.handle('cheshi:stage-git-paths', (event, paths) => {
    assertCheshiSender(event);
    return gitService.stagePaths(paths);
  });
  ipcMain.handle('cheshi:unstage-git-paths', (event, paths) => {
    assertCheshiSender(event);
    return gitService.unstagePaths(paths);
  });
  ipcMain.handle('cheshi:prepare-git-discard', (event, request) => {
    assertCheshiSender(event);
    return gitService.prepareDiscard(request);
  });
  ipcMain.handle('cheshi:discard-git-changes', (event, request) => {
    assertCheshiSender(event);
    return gitService.discardChanges(request, (filePath) => shell.trashItem(filePath));
  });
  ipcMain.handle('cheshi:commit-git-changes', (event, message) => {
    assertCheshiSender(event);
    return gitService.commit(message);
  });
  ipcMain.handle('cheshi:checkout-git-branch', (event, branchName) => {
    assertCheshiSender(event);
    return gitService.checkoutBranch(branchName);
  });
  ipcMain.handle('cheshi:create-git-branch', (event, branchName, startPoint) => {
    assertCheshiSender(event);
    return gitService.createBranch(branchName, startPoint);
  });
  ipcMain.handle('cheshi:update-git-branch', (event, branchReference) => {
    assertCheshiSender(event);
    return gitService.updateBranch(branchReference);
  });
  ipcMain.handle('cheshi:fetch-git-repository', (event) => {
    assertCheshiSender(event);
    return gitService.fetch();
  });
  ipcMain.handle('cheshi:push-git-current-branch', (event) => {
    assertCheshiSender(event);
    return gitService.pushCurrentBranch();
  });
  ipcMain.handle('cheshi:list-github-pull-requests', (event) => {
    assertCheshiSender(event);
    return gitService.listPullRequests();
  });
  ipcMain.handle('cheshi:get-github-pull-request-details', (event, number) => {
    assertCheshiSender(event);
    return gitService.getPullRequestDetails(number);
  });
  ipcMain.handle('cheshi:get-github-pull-request-diff', (event, number, commitOid) => {
    assertCheshiSender(event);
    return gitService.getPullRequestDiff(number, commitOid);
  });
  ipcMain.handle('cheshi:add-github-pull-request-comment', (event, request) => {
    assertCheshiSender(event);
    return gitService.addPullRequestComment(request);
  });
  ipcMain.handle('cheshi:add-github-pull-request-review-comment', (event, request) => {
    assertCheshiSender(event);
    return gitService.addPullRequestReviewComment(request);
  });
  ipcMain.handle('cheshi:submit-github-pull-request-review', (event, request) => {
    assertCheshiSender(event);
    return gitService.submitPullRequestReview(request);
  });
  ipcMain.handle('cheshi:create-github-pull-request', (event) => {
    assertCheshiSender(event);
    return gitService.createPullRequest();
  });
  ipcMain.handle('cheshi:checkout-github-pull-request', (event, number) => {
    assertCheshiSender(event);
    return gitService.checkoutPullRequest(number);
  });
  ipcMain.handle('cheshi:merge-github-pull-request', (event, request) => {
    assertCheshiSender(event);
    return gitService.mergePullRequest(request);
  });
  ipcMain.handle('cheshi:delete-github-pull-request-branch', (event, number) => {
    assertCheshiSender(event);
    return gitService.deletePullRequestBranch(number);
  });
  ipcMain.handle('cheshi:get-github-pull-request-branch-cleanup-status', (event, number) => {
    assertCheshiSender(event);
    return gitService.getPullRequestBranchCleanupStatus(number);
  });
  ipcMain.handle('cheshi:cleanup-github-pull-request-branch', (event, number) => {
    assertCheshiSender(event);
    return gitService.cleanupPullRequestBranch(number);
  });
  ipcMain.handle('cheshi:open-github-pull-request', async (event, url) => {
    assertCheshiSender(event);
    if (typeof url !== 'string') throw new TypeError('Pull request URL must be a string.');
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
      throw new TypeError('Pull request URL must use https://github.com.');
    }
    await shell.openExternal(parsedUrl.toString());
  });
}
