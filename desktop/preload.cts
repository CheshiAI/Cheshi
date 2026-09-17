import { createGitHubIssuesApi } from './lib/github-issue-preload.cts';
import { chatUserInputRequest, chatUserInputResponse } from './shared/chat-user-input.ts';
import { chatRelayHistoryRecord, chatRelayRequest, chatRelayState } from './shared/chat-relay.ts';
import { chatSavedTurn, chatSavedTurnInput } from './shared/chat-saved-turns.ts';
import { chatHistorySearchRequest, chatHistorySearchResponse } from './shared/chat-history-search.ts';
import { codeExplanationRequest, codeExplanationRequestId } from './shared/workspace-code-explanation.ts';
import { createTemporaryChatApi } from './lib/temporary-chat-preload.cts';
import { createAppleNotesApi } from './lib/apple-notes-preload.cts';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { prepareChatAttachmentTransfers } from './shared/chat-attachment-import.ts';
import { marketplaceAddRequest, pluginWorkflowRequest } from './shared/plugin-actions.ts';
import { gitDiscardRequest, gitDiscardSelection } from './shared/git-discard.ts';
import { createWorkspaceManagementApi } from './lib/workspace-management-preload.cts';
import { createWorkspaceFeatureApis } from './lib/workspace-feature-preload.cts';
import { createAppUpdateApi } from './lib/app-update-preload.cts';
import { createKeepAwakeApi } from './lib/keep-awake-preload.cts';
import { createEditorSessionApi } from './lib/editor-session-preload.cts';
import { createWorkspaceFileSearchApi } from './lib/workspace-file-search-preload.cts';
import { createChatQuestionDismissalsApi } from './lib/chat-question-dismissals-preload.cts';
import { installRendererReadiness } from './lib/renderer-readiness.mts';
import { workspaceDiskUsage } from './shared/workspace-disk-usage.ts';

import type { IpcRendererEvent } from 'electron';

import type {
  LanguageServerDiagnostic,
  CheshiDesktopApi,
} from './frontend/src/cheshiDesktop.ts';

async function deleteStoredChatRecord(channel: string, id: string, pattern: RegExp): Promise<{ id: string }> {
  if (typeof id !== 'string' || !pattern.test(id)) throw new TypeError('Invalid saved record id.');
  const value: unknown = await ipcRenderer.invoke(channel, id);
  assertRecord(value, 'Invalid saved record deletion response.');
  if (value.id !== id) throw new TypeError('Invalid saved record deletion response.');
  return { id };
}

function assertRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }
}

function booleanValue(value: unknown, message: string): boolean {
  if (value !== true && value !== false) throw new TypeError(message);
  return value;
}

function chatMessageInvoker(channel: string): CheshiDesktopApi['sendCodexChatMessage'] {
  return (text, clientMessageId, skill = null, attachments = [], threadId = undefined, contextId) => {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('Chat message must be a non-empty string.');
    if (typeof clientMessageId !== 'string' || !clientMessageId.trim()) {
      throw new TypeError('Client message id must be a non-empty string.');
    }
    if (skill !== null && (typeof skill !== 'object' || Array.isArray(skill))) {
      throw new TypeError('Chat skill must be an object.');
    }
    if (!Array.isArray(attachments)) throw new TypeError('Chat attachments must be an array.');
    if (threadId !== undefined && threadId !== null && (typeof threadId !== 'string' || !threadId.trim())) {
      throw new TypeError('Chat session id must be undefined, null, or a non-empty string.');
    }
    return ipcRenderer.invoke(channel, {
      text,
      clientMessageId,
      skill,
      attachments,
      threadId,
    }, contextId);
  };
}

const workspace = ipcRenderer.sendSync('cheshi:get-workspace-metadata');
const CODEX_ACCOUNT_USAGE_CHANNEL = 'cheshi:codex-account-usage-changed';
const CODEX_CHAT_EVENT_CHANNEL = 'cheshi:codex-chat-event';
const GIT_REPOSITORY_CHANGED_CHANNEL = 'cheshi:git-repository-changed';
const GITHUB_COMMENT_BODY_LIMIT = 65_536;
const LANGUAGE_SERVER_DIAGNOSTICS_CHANNEL = 'cheshi:language-server-diagnostics';
const RENDERER_READY_CHANNEL = 'cheshi:renderer-ready';
const TERMINAL_STATE_CHANNEL = 'cheshi:terminal-state-changed';
const WORKSPACE_FILES_CHANGED_CHANNEL = 'cheshi:workspace-files-changed';
const WORKSPACE_FILES_CHANGED_PATH_LIMIT = 512;

installRendererReadiness(window, document, (theme) => ipcRenderer.send(RENDERER_READY_CHANNEL, theme));

function workspaceRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Workspace path must be a non-empty string.');
  }
  return value;
}

function workspaceFilesChangedEvent(value: unknown) {
  assertRecord(value, 'Workspace files changed event must be an object.');
  if (!Array.isArray(value.paths) || value.paths.length > WORKSPACE_FILES_CHANGED_PATH_LIMIT) {
    throw new TypeError('Workspace files changed paths must be a bounded array.');
  }
  const overflow = booleanValue(
    value.overflow,
    'Workspace files changed overflow flag must be a boolean.',
  );
  return {
    paths: value.paths.map(workspaceRelativePath),
    overflow,
  };
}

function gitWorkspacePath(value: unknown): string {
  const filePath = workspaceRelativePath(value).trim();
  if (filePath.includes('\0') || filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    throw new TypeError('Git path must be workspace-relative.');
  }
  return filePath;
}

function gitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) {
    throw new TypeError('Git paths must contain between 1 and 1000 entries.');
  }
  return value.map(gitWorkspacePath);
}

function gitDiffRequest(value: unknown) {
  assertRecord(value, 'Git diff request must be an object.');
  if (value.scope !== 'working' && value.scope !== 'staged' && value.scope !== 'commit') {
    throw new TypeError('Git diff scope is invalid.');
  }
  const filePath = typeof value.path === 'string' && value.path.trim()
    ? gitWorkspacePath(value.path)
    : '';
  if (value.scope !== 'commit' && !filePath) {
    throw new TypeError('Working tree diffs require a file path.');
  }
  if (
    value.scope === 'commit'
    && (typeof value.commit !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(value.commit))
  ) {
    throw new TypeError('Git commit must be a hexadecimal object id.');
  }
  return {
    scope: value.scope,
    path: filePath,
    ...(value.scope === 'commit' ? { commit: value.commit } : {}),
  };
}

function gitBranchName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-')) {
    throw new TypeError('Git branch name must be non-empty.');
  }
  return value.trim();
}

function gitBranchReference(value: unknown): string {
  const reference = gitBranchName(value);
  if (!reference.startsWith('refs/heads/') && !reference.startsWith('refs/remotes/')) {
    throw new TypeError('Git branch reference must identify a local or remote branch.');
  }
  return reference;
}

function gitCommitMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) {
    throw new TypeError('Git commit message must be non-empty and at most 20000 characters.');
  }
  return value.trim();
}

function pullRequestNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Pull request number must be a positive integer.');
  }
  return value;
}

function pullRequestCommitId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/iu.test(value)) {
    throw new TypeError('Pull request commit must be a full object ID.');
  }
  return value;
}

function pullRequestMergeRequest(value: unknown) {
  assertRecord(value, 'Pull request merge request must be an object.');
  if (value.method !== 'merge' && value.method !== 'squash' && value.method !== 'rebase') {
    throw new TypeError('Pull request merge method is invalid.');
  }
  return {
    number: pullRequestNumber(value.number),
    method: value.method,
  };
}

function pullRequestCommentRequest(value: unknown) {
  assertRecord(value, 'Pull request comment request must be an object.');
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (!body || body.length > GITHUB_COMMENT_BODY_LIMIT) {
    throw new TypeError(`Pull request comment must be between 1 and ${GITHUB_COMMENT_BODY_LIMIT} characters.`);
  }
  return {
    number: pullRequestNumber(value.number),
    body,
  };
}

function pullRequestNodeId(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 512
    || /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`Pull request ${fieldName} must be a valid node ID.`);
  }
  return value;
}

function pullRequestReviewCommentRequest(value: unknown) {
  assertRecord(value, 'Pull request review comment request must be an object.');
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (!body || body.length > GITHUB_COMMENT_BODY_LIMIT) {
    throw new TypeError(`Pull request review comment must be between 1 and ${GITHUB_COMMENT_BODY_LIMIT} characters.`);
  }
  if (value.mode !== 'comment' && value.mode !== 'review') {
    throw new TypeError('Pull request review comment mode is invalid.');
  }
  const commitId = pullRequestCommitId(value.commitId);
  const filePath = gitWorkspacePath(value.path).replaceAll('\\', '/');
  if (filePath.split('/').includes('..') || /[\r\n]/u.test(filePath)) {
    throw new TypeError('Pull request review path must be repository-relative.');
  }
  if (typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line < 1) {
    throw new TypeError('Pull request review line must be a positive integer.');
  }
  if (value.side !== 'LEFT' && value.side !== 'RIGHT') {
    throw new TypeError('Pull request review side must be LEFT or RIGHT.');
  }
  const pendingReviewId = value.pendingReviewId === null
    ? null
    : pullRequestNodeId(value.pendingReviewId, 'pending review ID');
  if (value.mode === 'comment' && pendingReviewId !== null) {
    throw new TypeError('A single pull request review comment cannot target a pending review.');
  }
  return {
    number: pullRequestNumber(value.number),
    pullRequestId: pullRequestNodeId(value.pullRequestId, 'ID'),
    commitId,
    path: filePath,
    line: value.line,
    side: value.side,
    body,
    mode: value.mode,
    pendingReviewId,
  };
}

function pullRequestReviewSubmissionRequest(value: unknown) {
  assertRecord(value, 'Pull request review submission request must be an object.');
  if (value.event !== 'APPROVE' && value.event !== 'COMMENT' && value.event !== 'REQUEST_CHANGES') {
    throw new TypeError('Pull request review event is invalid.');
  }
  return {
    number: pullRequestNumber(value.number),
    reviewId: pullRequestNodeId(value.reviewId, 'pending review ID'),
    event: value.event,
  };
}

function githubPullRequestUrl(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Pull request URL must be a string.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new TypeError('Pull request URL must use https://github.com.');
  }
  return parsed.toString();
}

function workspaceFileWriteRequest(value: unknown) {
  assertRecord(value, 'Workspace file write request must be an object.');
  const path = workspaceRelativePath(value.path);
  if (typeof value.content !== 'string') throw new TypeError('Workspace file content must be a string.');
  if (typeof value.expectedRevision !== 'string' || !value.expectedRevision) {
    throw new TypeError('Workspace file revision must be a non-empty string.');
  }
  if ('hasBom' in value && value.hasBom !== undefined && value.hasBom !== true && value.hasBom !== false) {
    throw new TypeError('Workspace file BOM flag must be a boolean.');
  }
  if (
    'lineEnding' in value
    && value.lineEnding !== undefined
    && value.lineEnding !== 'lf'
    && value.lineEnding !== 'crlf'
    && value.lineEnding !== 'cr'
  ) {
    throw new TypeError('Workspace file line ending is invalid.');
  }
  return {
    path,
    content: value.content,
    expectedRevision: value.expectedRevision,
    ...(value.hasBom === undefined ? {} : { hasBom: value.hasBom }),
    ...(value.lineEnding === undefined ? {} : { lineEnding: value.lineEnding }),
  };
}

function workspaceFilesWriteRequest(value: unknown) {
  assertRecord(value, 'Workspace file write batch must contain a files array.');
  if (!Array.isArray(value.files)) {
    throw new TypeError('Workspace file write batch must contain a files array.');
  }
  if (value.files.length < 1 || value.files.length > 100) {
    throw new TypeError('Workspace file write batch must contain between 1 and 100 files.');
  }
  return { files: value.files.map(workspaceFileWriteRequest) };
}

function workspaceFileExcerptRequest(value: unknown) {
  assertRecord(value, 'Workspace file excerpt request must be an object.');
  const path = workspaceRelativePath(value.path);
  if (typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line < 1) {
    throw new TypeError('Workspace file excerpt line must be a positive integer.');
  }
  if (
    value.contextLines !== undefined
    && (
      typeof value.contextLines !== 'number'
      || !Number.isSafeInteger(value.contextLines)
      || value.contextLines < 0
      || value.contextLines > 200
    )
  ) {
    throw new TypeError('Workspace file excerpt context must be between 0 and 200 lines.');
  }
  return {
    path,
    line: value.line,
    ...(value.contextLines === undefined ? {} : { contextLines: value.contextLines }),
  };
}

function workspaceEntryRenameRequest(value: unknown) {
  assertRecord(value, 'Workspace rename request must be an object.');
  const path = workspaceRelativePath(value.path);
  return { path, newName: workspaceEntryName(value.newName) };
}

function workspaceEntryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Workspace entry name must be a non-empty string.');
  }
  if (
    value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new TypeError('Workspace entry name cannot contain path separators.');
  }
  return value;
}

function workspaceEntryCreateRequest(value: unknown) {
  assertRecord(value, 'Workspace create request must be an object.');
  const directoryPath = workspaceRelativePath(value.directoryPath);
  const name = workspaceEntryName(value.name);
  if (value.kind !== 'file' && value.kind !== 'directory') {
    throw new TypeError('Workspace entry kind must be file or directory.');
  }
  return { directoryPath, name, kind: value.kind };
}

function workspaceEntryMoveRequest(value: unknown) {
  assertRecord(value, 'Workspace move request must be an object.');
  return {
    path: workspaceRelativePath(value.path),
    destinationDirectory: workspaceRelativePath(value.destinationDirectory),
  };
}

function terminalId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function terminalVisibility(value: unknown): boolean {
  return booleanValue(value, 'Terminal visibility must be a boolean.');
}

function terminalTheme(value: unknown): 'dark' | 'light' {
  if (value !== 'dark' && value !== 'light') {
    throw new TypeError('Terminal theme must be dark or light.');
  }
  return value;
}

function terminalSplitDirection(value: unknown): 'right' | 'left' | 'down' | 'up' {
  if (value !== 'right' && value !== 'left' && value !== 'down' && value !== 'up') {
    throw new TypeError('Terminal split direction is invalid.');
  }
  return value;
}

function terminalSplitRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 0.9) {
    throw new TypeError('Terminal split ratio must be between 0.1 and 0.9.');
  }
  return value;
}

function terminalSurfaceBounds(value: unknown) {
  assertRecord(value, 'Terminal surface bounds must be an object.');
  const bounds: Record<string, number> = {};
  for (const field of ['x', 'y', 'width', 'height']) {
    const coordinate = value[field];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
      throw new TypeError(`Terminal surface ${field} must be a finite number.`);
    }
    bounds[field] = coordinate;
  }
  return {
    paneId: terminalId(value.paneId, 'Terminal pane id'),
    ...bounds,
    visible: terminalVisibility(value.visible),
  };
}

function languageServerLanguage(value: unknown): 'rust' | 'typescript' | 'python' {
  if (value !== 'rust' && value !== 'typescript' && value !== 'python') {
    throw new TypeError('Language server language is invalid.');
  }
  return value;
}

function languageServerConfiguration(value: unknown) {
  assertRecord(value, 'Language server configuration must be an object.');
  const language = languageServerLanguage(value.language);
  if (value.mode !== 'auto' && value.mode !== 'custom' && value.mode !== 'disabled') {
    throw new TypeError('Language server mode is invalid.');
  }
  if (value.mode === 'custom') {
    if (typeof value.executable !== 'string' || !value.executable.trim()) {
      throw new TypeError('A custom language server executable is required.');
    }
    return { language, mode: value.mode, executable: value.executable.trim() };
  }
  return { language, mode: value.mode };
}

function languageServerDocument(value: unknown, includeContent: boolean) {
  assertRecord(value, 'Language server document request must be an object.');
  const request = {
    language: languageServerLanguage(value.language),
    path: workspaceRelativePath(value.path),
  };
  if (!includeContent) return request;
  if (typeof value.content !== 'string') throw new TypeError('Language server document content must be a string.');
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new TypeError('Language server document version must be a positive integer.');
  }
  return { ...request, content: value.content, version: value.version };
}

function languageServerPosition(value: unknown) {
  assertRecord(value, 'Language server document position is invalid.');
  if (
    typeof value.line !== 'number'
    || !Number.isSafeInteger(value.line)
    || value.line < 0
    || typeof value.character !== 'number'
    || !Number.isSafeInteger(value.character)
    || value.character < 0
  ) {
    throw new TypeError('Language server document position is invalid.');
  }
  return { line: value.line, character: value.character };
}

function languageServerRange(value: unknown) {
  assertRecord(value, 'Language server document range is invalid.');
  return {
    start: languageServerPosition(value.start),
    end: languageServerPosition(value.end),
  };
}

function languageServerDiagnostic(value: unknown): LanguageServerDiagnostic {
  assertRecord(value, 'Language server diagnostic is invalid.');
  if (typeof value.message !== 'string') throw new TypeError('Language server diagnostic message is invalid.');
  const diagnostic: LanguageServerDiagnostic = {
    range: languageServerRange(value.range),
    message: value.message,
  };
  if (value.severity !== undefined) {
    if (typeof value.severity !== 'number' || !Number.isSafeInteger(value.severity)) {
      throw new TypeError('Language server diagnostic severity is invalid.');
    }
    diagnostic.severity = value.severity;
  }
  if (value.code !== undefined) {
    if (typeof value.code !== 'string' && typeof value.code !== 'number') {
      throw new TypeError('Language server diagnostic code is invalid.');
    }
    diagnostic.code = value.code;
  }
  if (value.source !== undefined) {
    if (typeof value.source !== 'string') throw new TypeError('Language server diagnostic source is invalid.');
    diagnostic.source = value.source;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || !value.tags.every((tag) => tag === 1 || tag === 2)) {
      throw new TypeError('Language server diagnostic tags are invalid.');
    }
    diagnostic.tags = [...value.tags];
  }
  return diagnostic;
}

function languageServerFeatureRequest(value: unknown) {
  assertRecord(value, 'Language server feature request must be an object.');
  const request = languageServerDocument(value, true);
  return { ...request, position: languageServerPosition(value.position) };
}

function languageServerRenameRequest(value: unknown) {
  assertRecord(value, 'Language server rename request must be an object.');
  const request = languageServerFeatureRequest(value);
  if (
    typeof value.newName !== 'string'
    || !value.newName
    || value.newName.length > 256
    || value.newName.includes('\0')
    || value.newName.includes('\n')
    || value.newName.includes('\r')
  ) {
    throw new TypeError('Language server rename name is invalid.');
  }
  return { ...request, newName: value.newName };
}

function languageServerCodeActionRequest(value: unknown) {
  assertRecord(value, 'Language server code action request must be an object.');
  const request = languageServerDocument(value, true);
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 200) {
    throw new TypeError('Language server code action diagnostics are invalid.');
  }
  return {
    ...request,
    range: languageServerRange(value.range),
    diagnostics: value.diagnostics.map(languageServerDiagnostic),
  };
}

function codexPluginReference(value: unknown) {
  assertRecord(value, 'Plugin reference must be an object.');
  if (typeof value.pluginName !== 'string' || !value.pluginName.trim()) {
    throw new TypeError('Plugin name must be a non-empty string.');
  }
  const marketplacePath = typeof value.marketplacePath === 'string' && value.marketplacePath.trim()
    ? value.marketplacePath.trim()
    : null;
  const remoteMarketplaceName = typeof value.remoteMarketplaceName === 'string' && value.remoteMarketplaceName.trim()
    ? value.remoteMarketplaceName.trim()
    : null;
  if ((marketplacePath === null) === (remoteMarketplaceName === null)) {
    throw new TypeError('Plugin reference must identify exactly one marketplace.');
  }
  return {
    pluginName: value.pluginName.trim(),
    ...(marketplacePath ? { marketplacePath } : { remoteMarketplaceName }),
  };
}

const cheshiDesktopApi = {
  ...createAppUpdateApi(ipcRenderer),
  ...createKeepAwakeApi(ipcRenderer),
  ...createWorkspaceFileSearchApi(ipcRenderer),
  workspaceManagement: createWorkspaceManagementApi(ipcRenderer),
  ...createWorkspaceFeatureApis(ipcRenderer),
  platform: process.platform,
  workspaceName: workspace.workspaceName,
  userName: typeof workspace.userName === 'string' ? workspace.userName : '',
  workspaceRoot: workspace.workspaceRoot,
  getWorkspaceDiskUsage: async () => workspaceDiskUsage(await ipcRenderer.invoke('cheshi:get-workspace-disk-usage')),
  isCodeGraphIndexed: () => ipcRenderer.invoke('cheshi:is-codegraph-indexed'),
  reindexCodeGraph: () => ipcRenderer.invoke('cheshi:reindex-codegraph'),
  listWorkspaceDirectory: (relativePath = '.') => ipcRenderer.invoke('cheshi:list-workspace-directory', workspaceRelativePath(relativePath)),
  readWorkspaceFile: (relativePath) => ipcRenderer.invoke('cheshi:read-workspace-file', workspaceRelativePath(relativePath)),
  localHistory: {
    list: (relativePath) => ipcRenderer.invoke('cheshi:list-local-history', workspaceRelativePath(relativePath)),
    read: (relativePath, id) => ipcRenderer.invoke('cheshi:read-local-history', workspaceRelativePath(relativePath), id),
    restore: (request) => ipcRenderer.invoke('cheshi:restore-local-history', request),
  },
  readWorkspaceFileExcerpt: (request) => ipcRenderer.invoke(
    'cheshi:read-workspace-file-excerpt',
    workspaceFileExcerptRequest(request),
  ),
  getWorkspaceFileVersion: (relativePath) => ipcRenderer.invoke('cheshi:get-workspace-file-version', workspaceRelativePath(relativePath)),
  writeWorkspaceFile: (request) => ipcRenderer.invoke('cheshi:write-workspace-file', workspaceFileWriteRequest(request)),
  writeWorkspaceFiles: (request) => ipcRenderer.invoke('cheshi:write-workspace-files', workspaceFilesWriteRequest(request)),
  createWorkspaceEntry: (request) => ipcRenderer.invoke('cheshi:create-workspace-entry', workspaceEntryCreateRequest(request)),
  renameWorkspaceEntry: (request) => ipcRenderer.invoke('cheshi:rename-workspace-entry', workspaceEntryRenameRequest(request)),
  moveWorkspaceEntry: (request) => ipcRenderer.invoke('cheshi:move-workspace-entry', workspaceEntryMoveRequest(request)),
  copyWorkspaceEntryFullPath: (relativePath) => ipcRenderer.invoke('cheshi:copy-workspace-entry-full-path', workspaceRelativePath(relativePath)),
  deleteWorkspaceEntry: (relativePath) => ipcRenderer.invoke('cheshi:delete-workspace-entry', workspaceRelativePath(relativePath)),
  onWorkspaceFilesChanged: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('Workspace files changed handler must be a function.');
    const listener = (_event: IpcRendererEvent, value: unknown) => (
      handler(workspaceFilesChangedEvent(value))
    );
    ipcRenderer.on(WORKSPACE_FILES_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(WORKSPACE_FILES_CHANGED_CHANNEL, listener);
  },
  getGitSnapshot: () => ipcRenderer.invoke('cheshi:get-git-snapshot'),
  getGitBranchCommits: async (branchReference) => ipcRenderer.invoke(
    'cheshi:get-git-branch-commits', gitBranchReference(branchReference),
  ),
  getGitDiff: (request) => ipcRenderer.invoke('cheshi:get-git-diff', gitDiffRequest(request)),
  stageGitPaths: (paths) => ipcRenderer.invoke('cheshi:stage-git-paths', gitPaths(paths)),
  unstageGitPaths: (paths) => ipcRenderer.invoke('cheshi:unstage-git-paths', gitPaths(paths)),
  prepareGitDiscard: async (request) => ipcRenderer.invoke('cheshi:prepare-git-discard', gitDiscardSelection(request)),
  discardGitChanges: async (request) => ipcRenderer.invoke('cheshi:discard-git-changes', gitDiscardRequest(request)),
  commitGitChanges: (message) => ipcRenderer.invoke('cheshi:commit-git-changes', gitCommitMessage(message)),
  checkoutGitBranch: (branchName) => ipcRenderer.invoke('cheshi:checkout-git-branch', gitBranchName(branchName)),
  createGitBranch: (branchName, startPoint) => ipcRenderer.invoke(
    'cheshi:create-git-branch',
    gitBranchName(branchName),
    startPoint === undefined ? null : gitBranchReference(startPoint),
  ),
  updateGitBranch: (branchReference) => ipcRenderer.invoke(
    'cheshi:update-git-branch',
    gitBranchReference(branchReference),
  ),
  fetchGitRepository: () => ipcRenderer.invoke('cheshi:fetch-git-repository'),
  pushGitCurrentBranch: () => ipcRenderer.invoke('cheshi:push-git-current-branch'),
  listGitHubPullRequests: () => ipcRenderer.invoke('cheshi:list-github-pull-requests'),
  getGitHubPullRequestDetails: (number) => ipcRenderer.invoke(
    'cheshi:get-github-pull-request-details',
    pullRequestNumber(number),
  ),
  getGitHubPullRequestDiff: async (number, commitOid) => ipcRenderer.invoke(
    'cheshi:get-github-pull-request-diff',
    pullRequestNumber(number),
    commitOid === undefined ? undefined : pullRequestCommitId(commitOid),
  ),
  addGitHubPullRequestComment: (request) => ipcRenderer.invoke(
    'cheshi:add-github-pull-request-comment',
    pullRequestCommentRequest(request),
  ),
  addGitHubPullRequestReviewComment: (request) => ipcRenderer.invoke(
    'cheshi:add-github-pull-request-review-comment',
    pullRequestReviewCommentRequest(request),
  ),
  submitGitHubPullRequestReview: (request) => ipcRenderer.invoke(
    'cheshi:submit-github-pull-request-review',
    pullRequestReviewSubmissionRequest(request),
  ),
  createGitHubPullRequest: () => ipcRenderer.invoke('cheshi:create-github-pull-request'),
  checkoutGitHubPullRequest: (number) => ipcRenderer.invoke(
    'cheshi:checkout-github-pull-request',
    pullRequestNumber(number),
  ),
  mergeGitHubPullRequest: (request) => ipcRenderer.invoke(
    'cheshi:merge-github-pull-request',
    pullRequestMergeRequest(request),
  ),
  deleteGitHubPullRequestBranch: (number) => ipcRenderer.invoke(
    'cheshi:delete-github-pull-request-branch',
    pullRequestNumber(number),
  ),
  getGitHubPullRequestBranchCleanupStatus: (number) => ipcRenderer.invoke(
    'cheshi:get-github-pull-request-branch-cleanup-status',
    pullRequestNumber(number),
  ),
  cleanupGitHubPullRequestBranch: (number) => ipcRenderer.invoke(
    'cheshi:cleanup-github-pull-request-branch',
    pullRequestNumber(number),
  ),
  openGitHubPullRequest: (url) => ipcRenderer.invoke(
    'cheshi:open-github-pull-request',
    githubPullRequestUrl(url),
  ),
  onGitRepositoryChanged: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('Git repository change handler must be a function.');
    const listener = () => handler();
    ipcRenderer.on(GIT_REPOSITORY_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(GIT_REPOSITORY_CHANGED_CHANNEL, listener);
  },
  getLanguageServers: () => ipcRenderer.invoke('cheshi:get-language-servers'),
  configureLanguageServer: (request) => ipcRenderer.invoke(
    'cheshi:configure-language-server',
    languageServerConfiguration(request),
  ),
  selectLanguageServerExecutable: (language) => ipcRenderer.invoke(
    'cheshi:select-language-server-executable',
    languageServerLanguage(language),
  ),
  updateLanguageServerDocument: (request) => ipcRenderer.invoke(
    'cheshi:update-language-server-document',
    languageServerDocument(request, true),
  ),
  getLanguageServerCompletions: (request) => ipcRenderer.invoke(
    'cheshi:get-language-server-completions',
    languageServerFeatureRequest(request),
  ),
  getLanguageServerHover: (request) => ipcRenderer.invoke(
    'cheshi:get-language-server-hover',
    languageServerFeatureRequest(request),
  ),
  getLanguageServerDefinitions: (request) => ipcRenderer.invoke(
    'cheshi:get-language-server-definitions',
    languageServerFeatureRequest(request),
  ),
  getLanguageServerReferences: (request) => ipcRenderer.invoke(
    'cheshi:get-language-server-references',
    languageServerFeatureRequest(request),
  ),
  getLanguageServerSignatureHelp: (request) => ipcRenderer.invoke(
    'cheshi:get-language-server-signature-help',
    languageServerFeatureRequest(request),
  ),
  prepareLanguageServerRename: (request) => ipcRenderer.invoke(
    'cheshi:prepare-language-server-rename',
    languageServerFeatureRequest(request),
  ),
  renameLanguageServerSymbol: (request) => ipcRenderer.invoke(
    'cheshi:rename-language-server-symbol',
    languageServerRenameRequest(request),
  ),
  getLanguageServerCodeActions: (request) => ipcRenderer.invoke(
    'cheshi:get-language-server-code-actions',
    languageServerCodeActionRequest(request),
  ),
  closeLanguageServerDocument: (request) => ipcRenderer.invoke(
    'cheshi:close-language-server-document',
    languageServerDocument(request, false),
  ),
  onLanguageServerDiagnostics: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('Language server diagnostics handler must be a function.');
    const listener = (_event: IpcRendererEvent, value: unknown) => handler(value);
    ipcRenderer.on(LANGUAGE_SERVER_DIAGNOSTICS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(LANGUAGE_SERVER_DIAGNOSTICS_CHANNEL, listener);
  },
  setTerminalViewVisible: (visible) => ipcRenderer.invoke(
    'cheshi:set-terminal-view-visible',
    terminalVisibility(visible),
  ),
  setTerminalTheme: (theme) => ipcRenderer.invoke('cheshi:set-terminal-theme', terminalTheme(theme)),
  updateTerminalSurfaceBounds: (bounds) => ipcRenderer.send(
    'cheshi:update-terminal-surface-bounds',
    terminalSurfaceBounds(bounds),
  ),
  newTerminalSession: () => ipcRenderer.invoke('cheshi:new-terminal-session'),
  selectTerminalSession: (sessionId) => ipcRenderer.invoke(
    'cheshi:select-terminal-session',
    terminalId(sessionId, 'Terminal session id'),
  ),
  closeTerminalSession: (sessionId) => ipcRenderer.invoke(
    'cheshi:close-terminal-session',
    terminalId(sessionId, 'Terminal session id'),
  ),
  selectTerminalPane: (sessionId, paneId) => ipcRenderer.invoke(
    'cheshi:select-terminal-pane',
    terminalId(sessionId, 'Terminal session id'),
    terminalId(paneId, 'Terminal pane id'),
  ),
  splitTerminalPane: (sessionId, paneId, direction) => ipcRenderer.invoke(
    'cheshi:split-terminal-pane',
    terminalId(sessionId, 'Terminal session id'),
    terminalId(paneId, 'Terminal pane id'),
    terminalSplitDirection(direction),
  ),
  resizeTerminalSplit: (sessionId, splitId, ratio) => ipcRenderer.invoke(
    'cheshi:resize-terminal-split',
    terminalId(sessionId, 'Terminal session id'),
    terminalId(splitId, 'Terminal split id'),
    terminalSplitRatio(ratio),
  ),
  closeTerminalPane: (sessionId, paneId) => ipcRenderer.invoke(
    'cheshi:close-terminal-pane',
    terminalId(sessionId, 'Terminal session id'),
    terminalId(paneId, 'Terminal pane id'),
  ),
  onTerminalStateChanged: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('Terminal state handler must be a function.');
    const listener = (_event: IpcRendererEvent, value: unknown) => handler(value);
    ipcRenderer.on(TERMINAL_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(TERMINAL_STATE_CHANNEL, listener);
  },
  getCodexAccountUsage: () => ipcRenderer.invoke('cheshi:get-codex-account-usage'),
  codexAccounts: {
    list: () => ipcRenderer.invoke('cheshi:codex-accounts-list'),
    add: () => ipcRenderer.invoke('cheshi:codex-accounts-add'),
    login: (id) => ipcRenderer.invoke('cheshi:codex-accounts-login', id),
    logout: (id) => ipcRenderer.invoke('cheshi:codex-accounts-logout', id),
    cancelLogin: (id) => ipcRenderer.invoke('cheshi:codex-accounts-cancel-login', id),
    cancelRegistration: (id) => ipcRenderer.invoke('cheshi:codex-accounts-cancel-registration', id),
    select: (id) => ipcRenderer.invoke('cheshi:codex-accounts-select', id),
    onDidChange: (handler) => {
      if (typeof handler !== 'function') throw new TypeError('Account handler must be a function.');
      const listener = (_event: IpcRendererEvent, value: import('./shared/codex-accounts').CodexAccountsSnapshot) => handler(value);
      ipcRenderer.on('cheshi:codex-accounts-changed', listener);
      return () => ipcRenderer.removeListener('cheshi:codex-accounts-changed', listener);
    },
  },
  onCodexAccountUsageChanged: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('Codex account usage handler must be a function.');
    const listener = (_event: IpcRendererEvent, value: unknown) => handler(value);
    ipcRenderer.on(CODEX_ACCOUNT_USAGE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CODEX_ACCOUNT_USAGE_CHANNEL, listener);
  },
  listCodexChatSessions: (contextId) => ipcRenderer.invoke('cheshi:list-codex-chat-sessions', contextId),
  searchCodexChatHistory: async (request, contextId) => chatHistorySearchResponse(
    await ipcRenderer.invoke('cheshi:search-codex-chat-history', chatHistorySearchRequest(request), contextId),
  ),
  listCodexChatAgents: (contextId) => ipcRenderer.invoke('cheshi:list-codex-chat-agents', contextId),
  readCodexTurnMetrics: (threadId, contextId) => ipcRenderer.invoke('cheshi:read-codex-turn-metrics', threadId, contextId),
  readCodexAgentDetails: (threadId, agentThreadIds, contextId) => {
    if (typeof threadId !== 'string' || !threadId.trim() || !Array.isArray(agentThreadIds)
      || agentThreadIds.length === 0 || agentThreadIds.length > 32
      || agentThreadIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new TypeError('A conversation and valid agent thread ids are required.');
    }
    return ipcRenderer.invoke('cheshi:read-codex-agent-details', threadId, agentThreadIds, contextId);
  },
  listCodexSkills: (contextId) => ipcRenderer.invoke('cheshi:list-codex-skills', contextId),
  listCodexPlugins: (forceRefetch: unknown = false) => ipcRenderer.invoke(
    'cheshi:list-codex-plugins',
    booleanValue(forceRefetch, 'Plugin refresh flag must be a boolean.'),
  ),
  addCodexMarketplace: (request) => ipcRenderer.invoke('cheshi:add-codex-marketplace', marketplaceAddRequest(request)),
  explainCode: (request) => ipcRenderer.invoke('cheshi:explain-code', codeExplanationRequest(request)),
  cancelCodeExplanation: (requestId) => ipcRenderer.invoke('cheshi:cancel-code-explanation', codeExplanationRequestId(requestId)),
  temporaryChat: createTemporaryChatApi(ipcRenderer, file => webUtils.getPathForFile(file)),
  appleNotes: createAppleNotesApi(ipcRenderer, process.platform),
  startPluginWorkflow: (request, contextId) => ipcRenderer.invoke('cheshi:start-plugin-workflow', pluginWorkflowRequest(request), contextId),
  saveSkillRecording: (recording) => ipcRenderer.invoke('cheshi:save-skill-recording', recording),
  getCodexPluginLogo: (pluginId) => {
    if (typeof pluginId !== 'string' || !pluginId.trim()) {
      throw new TypeError('Plugin id must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:get-codex-plugin-logo', pluginId.trim());
  },
  readCodexPlugin: (reference) => ipcRenderer.invoke('cheshi:read-codex-plugin', codexPluginReference(reference)),
  installCodexPlugin: (reference) => ipcRenderer.invoke('cheshi:install-codex-plugin', codexPluginReference(reference)),
  uninstallCodexPlugin: (pluginId) => {
    if (typeof pluginId !== 'string' || !pluginId.trim()) {
      throw new TypeError('Plugin id must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:uninstall-codex-plugin', pluginId.trim());
  },
  listCodexModels: (contextId) => ipcRenderer.invoke('cheshi:list-codex-models', contextId),
  listCodexMcpServers: (contextId) => ipcRenderer.invoke('cheshi:list-codex-mcp-servers', contextId),
  listCodexPermissionModes: (contextId) => ipcRenderer.invoke('cheshi:list-codex-permission-modes', contextId),
  setCodexPermissionMode: (modeId, contextId) => {
    if (typeof modeId !== 'string' || !modeId.trim()) {
      throw new TypeError('Permission mode must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:set-codex-permission-mode', modeId, contextId);
  },
  setCodexChatCollaborationMode: (mode, contextId) => {
    if (mode !== 'default' && mode !== 'plan') throw new TypeError('Invalid collaboration mode.');
    return ipcRenderer.invoke('cheshi:set-codex-collaboration-mode', mode, contextId);
  },
  configureCodexChat: (options, contextId) => {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('Chat configuration must be an object.');
    }
    if ('model' in options && (typeof options.model !== 'string' || !options.model.trim())) {
      throw new TypeError('Chat model must be a non-empty string.');
    }
    if ('effort' in options && (typeof options.effort !== 'string' || !options.effort.trim())) {
      throw new TypeError('Reasoning effort must be a non-empty string.');
    }
    if ('fast' in options && options.fast !== true && options.fast !== false) {
      throw new TypeError('Fast mode must be a boolean.');
    }
    return ipcRenderer.invoke('cheshi:configure-codex-chat', options, contextId);
  },
  getCodexChatStatus: (contextId) => ipcRenderer.invoke('cheshi:get-codex-chat-status', contextId),
  getCodexChatGoal: (contextId) => ipcRenderer.invoke('cheshi:get-codex-chat-goal', contextId),
  setCodexChatGoal: (objective, contextId) => {
    if (typeof objective !== 'string' || !objective.trim()) {
      throw new TypeError('Goal objective must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:set-codex-chat-goal', objective, contextId);
  },
  listCodexChatUserInputs: async contextId => {
    const values: unknown = await ipcRenderer.invoke('cheshi:list-codex-chat-user-inputs', contextId);
    if (!Array.isArray(values)) throw new TypeError('The input request list is invalid.');
    return values.map(value => {
      const request = chatUserInputRequest(value);
      if (!request) throw new TypeError('An input request is invalid.');
      return request;
    });
  },
  respondCodexChatUserInput: (requestId, response, contextId) => {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('The input request id is invalid.');
    return ipcRenderer.invoke('cheshi:respond-codex-chat-user-input', requestId, chatUserInputResponse(response), contextId);
  },
  respondCodexChatApproval: (approvalId, decision, contextId) => {
    if (typeof approvalId !== 'string' || !approvalId.trim()) {
      throw new TypeError('Approval request id must be a non-empty string.');
    }
    if (decision !== 'accept' && decision !== 'acceptForSession' && decision !== 'decline') {
      throw new TypeError('The approval decision is invalid.');
    }
    return ipcRenderer.invoke('cheshi:respond-codex-chat-approval', approvalId, decision, contextId);
  },
  openCodexChatSession: (sessionId, contextId) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new TypeError('Chat session id must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:open-codex-chat-session', sessionId, contextId);
  },
  deleteCodexChatSession: (sessionId, contextId) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new TypeError('Chat session id must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:delete-codex-chat-session', sessionId, contextId);
  },
  openCodexChatAgent: (agentThreadId, contextId) => {
    if (typeof agentThreadId !== 'string' || !agentThreadId.trim()) {
      throw new TypeError('Agent thread id must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:open-codex-chat-agent', agentThreadId, contextId);
  },
  newCodexChatSession: (contextId) => ipcRenderer.invoke('cheshi:new-codex-chat-session', contextId),
  forkCodexChatSession: (contextId) => ipcRenderer.invoke('cheshi:fork-codex-chat-session', contextId),
  compactCodexChatSession: (contextId) => ipcRenderer.invoke('cheshi:compact-codex-chat-session', contextId),
  reviewCodexChatSession: (contextId) => ipcRenderer.invoke('cheshi:review-codex-chat-session', contextId),
  selectCodexChatAttachments: () => ipcRenderer.invoke('cheshi:select-codex-chat-attachments'),
  importCodexChatAttachments: async (files) => {
    const payload = await prepareChatAttachmentTransfers(files, (file) => webUtils.getPathForFile(file as File));
    return ipcRenderer.invoke('cheshi:import-codex-chat-attachments', payload);
  },
  getCodexChatAttachmentPreview: (attachmentPath) => {
    if (typeof attachmentPath !== 'string' || !attachmentPath.trim()) {
      throw new TypeError('Chat attachment path must be a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:get-codex-chat-attachment-preview', attachmentPath);
  },
  sendCodexChatMessage: chatMessageInvoker('cheshi:send-codex-chat-message'),
  steerCodexChatMessage: chatMessageInvoker('cheshi:steer-codex-chat-message'),
  cancelCodexChatResponse: (threadId = undefined, contextId) => {
    if (threadId !== undefined && threadId !== null && (typeof threadId !== 'string' || !threadId.trim())) {
      throw new TypeError('Chat session id must be undefined, null, or a non-empty string.');
    }
    return ipcRenderer.invoke('cheshi:cancel-codex-chat-response', threadId, contextId);
  },
  startCodexChatRelay: (request) => ipcRenderer.invoke('cheshi:start-codex-chat-relay', chatRelayRequest(request)),
  saveCodexTurn: async (input) => chatSavedTurn(await ipcRenderer.invoke('cheshi:save-codex-turn', chatSavedTurnInput(input))),
  githubIssues: createGitHubIssuesApi(ipcRenderer),
  editorSession: createEditorSessionApi(ipcRenderer),
  chatQuestionDismissals: createChatQuestionDismissalsApi(ipcRenderer),
  deleteCodexSavedTurn: (id) => deleteStoredChatRecord('cheshi:delete-codex-saved-turn', id, /^[a-f0-9]{64}$/),
  deleteCodexChatRelayHistory: (id) => deleteStoredChatRecord('cheshi:delete-codex-chat-relay-history', id, /^[a-zA-Z0-9_-]{1,128}$/),
  listCodexSavedTurns: async () => {
    const value: unknown = await ipcRenderer.invoke('cheshi:list-codex-saved-turns');
    if (!Array.isArray(value)) throw new TypeError('Invalid saved turns response.');
    return value.map(chatSavedTurn);
  },
  stopCodexChatRelay: () => ipcRenderer.invoke('cheshi:stop-codex-chat-relay'),
  getCodexChatRelay: () => ipcRenderer.invoke('cheshi:get-codex-chat-relay'),
  listCodexChatRelayHistory: async () => {
    const value: unknown = await ipcRenderer.invoke('cheshi:list-codex-chat-relay-history');
    if (!Array.isArray(value)) throw new TypeError('Invalid conversation history response.');
    return value.map((entry) => {
      const record = chatRelayHistoryRecord(entry);
      if (!record) throw new TypeError('Invalid conversation history record.');
      return record;
    });
  },
  onCodexChatRelayEvent: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('Relay event handler must be a function.');
    const listener = (_event: IpcRendererEvent, value: unknown) => {
      const state = chatRelayState(value);
      if (state) handler(state);
    };
    ipcRenderer.on('cheshi:codex-chat-relay-event', listener);
    return () => ipcRenderer.removeListener('cheshi:codex-chat-relay-event', listener);
  },
  disposeCodexChatContext: (contextId) => ipcRenderer.invoke('cheshi:dispose-codex-chat-context', contextId),
  onCodexChatEvent: (handler, contextId) => {
    if (typeof handler !== 'function') throw new TypeError('Codex chat event handler must be a function.');
    const listener = (_event: IpcRendererEvent, value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      if (Reflect.get(value, 'contextId') === contextId) handler(value);
    };
    ipcRenderer.on(CODEX_CHAT_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CODEX_CHAT_EVENT_CHANNEL, listener);
  },
} satisfies CheshiDesktopApi;

contextBridge.exposeInMainWorld('cheshiDesktop', cheshiDesktopApi);
