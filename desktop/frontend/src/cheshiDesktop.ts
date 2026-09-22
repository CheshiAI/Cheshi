import type { GitLineBlameRequest, GitLineBlame, GitLineCommit } from '../../shared/git-line-blame';
import type { GitHubIssuesApi } from '../../shared/github-issues';
import type { ChatUserInputRequest, ChatUserInputResponse } from '../../shared/chat-user-input';
import type { AppUpdateApi, AppUpdateResumeApi } from '../../shared/app-update';
import type { KeepAwakeApi } from '../../shared/keep-awake';
import type { WorkspaceFileSearchResult } from '../../shared/workspace-file-search';
import type { LocalHistoryEntry, LocalHistorySnapshot, LocalHistoryRestoreRequest } from '../../shared/local-history';
import type { WorkspaceManagementApi } from '../../shared/workspace-management';
import type { GitDiscardPreview, GitDiscardRequest, GitDiscardSelection } from '../../shared/git-discard';

export type { GitDiscardPreview, GitDiscardRequest, GitDiscardSelection, GitDiscardTarget } from '../../shared/git-discard';

export type WorkspaceFileKind = 'text' | 'image' | 'binary' | 'too_large';
export type WorkspaceLineEnding = 'lf' | 'crlf' | 'cr';

export interface CheshiWorkspaceEntry {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  fileKind?: WorkspaceFileKind;
  size: number;
  modifiedAt: number;
  revision: string;
}

export interface WorkspaceFileVersion extends CheshiWorkspaceEntry {
  kind: 'file';
  fileKind: WorkspaceFileKind;
  hasBom: boolean;
  lineEnding: WorkspaceLineEnding;
}

export interface WorkspaceFileReadResult {
  file: WorkspaceFileVersion;
  content: string | null;
  dataUrl: string | null;
}

export interface WorkspaceFileExcerptResult {
  file: WorkspaceFileVersion;
  content: string;
  startLine: number;
  endLine: number;
  targetLine: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface WorkspaceFileWriteRequest {
  path: string;
  content: string;
  expectedRevision: string;
  hasBom?: boolean;
  lineEnding?: WorkspaceLineEnding;
}

export interface WorkspaceFileWriteResult {
  status: 'written' | 'conflict';
  file: WorkspaceFileVersion;
}

export interface WorkspaceFilesWriteResult {
  status: 'written' | 'conflict';
  files: WorkspaceFileVersion[];
}

export interface WorkspaceEntryRenameRequest {
  path: string;
  newName: string;
}

export interface WorkspaceEntryCreateRequest {
  directoryPath: string;
  name: string;
  kind: 'file' | 'directory';
}

export interface WorkspaceEntryCreateResult {
  path: string;
  kind: 'file' | 'directory';
}

export interface WorkspaceEntryRenameResult {
  previousPath: string;
  path: string;
}

export interface WorkspaceEntryMoveRequest {
  path: string;
  destinationDirectory: string;
}

export interface WorkspaceEntryMoveResult {
  previousPath: string;
  path: string;
}

export interface WorkspaceEntryDeleteResult {
  path: string;
}

export interface WorkspaceFilesChangedEvent {
  paths: string[];
  overflow: boolean;
}

export type WorkspaceEntryMutation =
  | { type: 'renamed'; previousPath: string; path: string }
  | { type: 'moved'; previousPath: string; path: string }
  | { type: 'deleted'; path: string };

export interface GitFileChange {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitBranchSummary {
  name: string;
  fullName: string;
  hash: string;
  upstream: string | null;
  upstreamRemote: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  remote: boolean;
}

export interface GitCommitSummary {
  hash: string;
  parents: string[];
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  decorations: string;
  subject: string;
}

export interface GitRepositorySnapshot {
  available: boolean;
  message: string;
  head?: string | null;
  detached?: boolean;
  upstream?: string | null;
  upstreamPublished?: boolean;
  ahead?: number;
  behind?: number;
  pullRequestBase?: string | null;
  pullRequestAhead?: number | null;
  changes?: GitFileChange[];
  branches?: GitBranchSummary[];
  commits?: GitCommitSummary[];
}

export type GitDiffScope = 'working' | 'staged' | 'commit';

export interface GitDiffRequest {
  scope: GitDiffScope;
  path: string;
  commit?: string;
}

export interface GitDiffResult {
  scope: GitDiffScope;
  path: string | null;
  commit: string | null;
  patch: string;
  truncated: boolean;
  binary: boolean;
}

export interface GitMutationResult {
  output: string;
  snapshot: GitRepositorySnapshot;
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  crossRepository?: boolean;
  baseRefName: string;
  author: string | null;
  updatedAt: string;
  draft: boolean;
  reviewDecision: string | null;
  changedFiles: number;
}

export interface GitHubPullRequestListResult {
  available: boolean;
  message: string;
  pullRequests: GitHubPullRequestSummary[];
}

export interface GitHubPullRequestComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  url: string;
  viewerDidAuthor: boolean;
}

export interface GitHubPullRequestCommit {
  oid: string;
  headline: string;
  body: string;
  authoredAt: string;
  authors: string[];
}

export type GitHubPullRequestReviewSide = 'LEFT' | 'RIGHT';
export type GitHubPullRequestReviewSubjectType = 'FILE' | 'LINE';

export interface GitHubPullRequestReviewComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  url: string;
  viewerDidAuthor: boolean;
  pending: boolean;
}

export interface GitHubPullRequestReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: GitHubPullRequestReviewSide;
  startSide: GitHubPullRequestReviewSide | null;
  subjectType: GitHubPullRequestReviewSubjectType;
  resolved: boolean;
  outdated: boolean;
  comments: GitHubPullRequestReviewComment[];
}

export interface GitHubPullRequestPendingReview {
  id: string;
  commentCount: number;
}

export interface GitHubPullRequestDetails {
  number: number;
  id: string;
  headRefOid: string;
  viewerLogin: string;
  comments: GitHubPullRequestComment[];
  commits: GitHubPullRequestCommit[];
  reviewThreads: GitHubPullRequestReviewThread[];
  pendingReview: GitHubPullRequestPendingReview | null;
}

export interface GitHubPullRequestDiffResult {
  number: number;
  path: null;
  headRefOid: string;
  patch: string;
  truncated: boolean;
  binary: boolean;
}

export interface GitHubPullRequestCommentRequest {
  number: number;
  body: string;
}

export type GitHubPullRequestReviewCommentMode = 'comment' | 'review';

export interface GitHubPullRequestReviewCommentRequest {
  number: number;
  pullRequestId: string;
  commitId: string;
  path: string;
  line: number;
  side: GitHubPullRequestReviewSide;
  body: string;
  mode: GitHubPullRequestReviewCommentMode;
  pendingReviewId: string | null;
}

export type GitHubPullRequestReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export interface GitHubPullRequestReviewSubmissionRequest {
  number: number;
  reviewId: string;
  event: GitHubPullRequestReviewEvent;
}

export type GitHubPullRequestMergeMethod = 'merge' | 'squash' | 'rebase';

export interface GitHubPullRequestMergeRequest {
  number: number;
  method: GitHubPullRequestMergeMethod;
}

export interface GitHubPullRequestMergeResult {
  number: number;
  method: GitHubPullRequestMergeMethod;
  headRefName: string;
  branchDeletionAvailable: boolean;
  output: string;
}

export type GitHubPullRequestBranchCleanupState =
  | 'ready'
  | 'base-behind'
  | 'complete'
  | 'worktree-dirty'
  | 'different-branch'
  | 'base-missing'
  | 'upstream-missing'
  | 'remote-branch-present'
  | 'local-commits-after-merge'
  | 'branch-not-merged'
  | 'base-ahead'
  | 'base-diverged';

export interface GitHubPullRequestBranchCleanupStatus {
  number: number;
  branch: string;
  baseBranch: string;
  currentBranch: string | null;
  upstream: string | null;
  state: GitHubPullRequestBranchCleanupState;
  canCleanup: boolean;
  canPush: boolean;
  branchAhead: number;
  baseAhead: number;
  baseBehind: number;
  localBranchExists: boolean;
  message: string;
  snapshot: GitRepositorySnapshot;
}

export interface GitHubPullRequestBranchCleanupResult extends GitHubPullRequestBranchCleanupStatus {
  output: string;
  updatedBase: boolean;
}

export interface GitHubPullRequestBranchDeleteResult {
  number: number;
  branch: string;
  baseBranch: string;
  output: string;
  refreshWarning: string | null;
  cleanup: GitHubPullRequestBranchCleanupStatus | null;
  snapshot: GitRepositorySnapshot;
}

export type LanguageServerLanguage = 'rust' | 'typescript' | 'python';
export type LanguageServerMode = 'auto' | 'custom' | 'disabled';
export type LanguageServerState = 'available' | 'disabled' | 'error' | 'missing' | 'running';

export interface LanguageServerStatus {
  language: LanguageServerLanguage;
  displayName: string;
  serverName: string;
  mode: LanguageServerMode;
  state: LanguageServerState;
  executable: string | null;
  message: string;
}

export interface LanguageServerPosition {
  line: number;
  character: number;
}

export interface LanguageServerRange {
  start: LanguageServerPosition;
  end: LanguageServerPosition;
}

export interface LanguageServerDiagnostic {
  range: LanguageServerRange;
  message: string;
  severity?: number;
  code?: unknown;
  source?: string;
  tags?: number[];
}

export interface LanguageServerDiagnosticsEvent {
  language: LanguageServerLanguage;
  path: string;
  version: number | null;
  diagnostics: unknown[];
}

export interface LanguageServerDocumentUpdateResult {
  active: boolean;
  version: number;
  status: LanguageServerStatus;
}

export interface LanguageServerCompletionTextEdit {
  range: LanguageServerRange;
  newText: string;
}

export interface LanguageServerCompletionItem {
  label: string;
  detail: string | null;
  documentation: string | null;
  kind: number | null;
  sortText: string | null;
  filterText: string | null;
  insertText: string;
  textEdit: LanguageServerCompletionTextEdit | null;
  deprecated: boolean;
  commitCharacters: string[];
}

export interface LanguageServerCompletionResult {
  isIncomplete: boolean;
  items: LanguageServerCompletionItem[];
}

export interface LanguageServerLocation {
  path: string;
  range: LanguageServerRange;
}

export interface LanguageServerDefinitionResult {
  locations: LanguageServerLocation[];
}

export interface LanguageServerHoverResult {
  contents: string[];
  range: LanguageServerRange | null;
}

export interface LanguageServerReferenceResult {
  locations: LanguageServerLocation[];
}

export interface LanguageServerSignatureParameter {
  label: string;
  documentation: string | null;
}

export interface LanguageServerSignature {
  label: string;
  documentation: string | null;
  parameters: LanguageServerSignatureParameter[];
  activeParameter: number | null;
}

export interface LanguageServerSignatureHelpResult {
  signatures: LanguageServerSignature[];
  activeSignature: number | null;
  activeParameter: number | null;
}

export interface LanguageServerTextEdit {
  range: LanguageServerRange;
  newText: string;
}

export interface LanguageServerWorkspaceEditFile {
  path: string;
  edits: LanguageServerTextEdit[];
}

export interface LanguageServerWorkspaceEdit {
  files: LanguageServerWorkspaceEditFile[];
}

export interface LanguageServerCodeAction {
  title: string;
  kind: string | null;
  preferred: boolean;
  disabledReason: string | null;
  edit: LanguageServerWorkspaceEdit | null;
}

export interface LanguageServerCodeActionResult {
  actions: LanguageServerCodeAction[];
}

export interface LanguageServerPrepareRenameResult {
  available: boolean;
  range: LanguageServerRange | null;
  placeholder: string | null;
}

export interface LanguageServerRenameResult {
  edit: LanguageServerWorkspaceEdit | null;
  failureReason: string | null;
}

export interface LanguageServerFeatureRequest {
  language: LanguageServerLanguage;
  path: string;
  content: string;
  version: number;
  position: LanguageServerPosition;
}

export interface LanguageServerCodeActionRequest {
  language: LanguageServerLanguage;
  path: string;
  content: string;
  version: number;
  range: LanguageServerRange;
  diagnostics: LanguageServerDiagnostic[];
}

export type TerminalSplitDirection = 'right' | 'left' | 'down' | 'up';
export type TerminalSplitAxis = 'columns' | 'rows';

export type TerminalPaneLayout =
  | { type: 'pane'; paneId: string }
  | {
      type: 'split';
      id: string;
      axis: TerminalSplitAxis;
      ratio: number;
      first: TerminalPaneLayout;
      second: TerminalPaneLayout;
    };

export interface TerminalPaneState {
  id: string;
  title: string;
  running: boolean;
}

export interface TerminalSessionState {
  id: string;
  title: string;
  panes: TerminalPaneState[];
  layout: TerminalPaneLayout;
}

export interface TerminalRuntimeState {
  available: boolean;
  error: string | null;
  cwd: string | null;
  sessions: TerminalSessionState[];
  activeSessionId: string | null;
  activePaneId: string | null;
}

export interface TerminalSurfaceBounds {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface CodexSkillReference {
  name: string;
  path: string;
}

export type CodexPluginReference = {
  pluginName: string;
  marketplacePath: string;
  remoteMarketplaceName?: never;
} | {
  pluginName: string;
  marketplacePath?: never;
  remoteMarketplaceName: string;
};

export interface CodexPluginSummary {
  id: string;
  name: string;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  developerName: string;
  category: string;
  capabilities: string[];
  keywords: string[];
  defaultPrompts: string[];
  brandColor: string | null;
  hasLogo: boolean;
  installed: boolean;
  enabled: boolean;
  installPolicy: string;
  authPolicy: string;
  availability: string;
  disabledReason: string | null;
  source: 'local' | 'git' | 'npm' | 'remote';
  version: string | null;
  localVersion: string | null;
  marketplaceName: string;
  marketplaceDisplayName: string;
  reference: CodexPluginReference;
}

export interface CodexPluginApp {
  id: string;
  name: string;
  description: string;
  category: string;
  installUrl: string | null;
}

export interface CodexPluginDetail extends CodexPluginSummary {
  description: string;
  shareUrl: string | null;
  skills: Array<{ name: string; displayName: string; description: string; enabled: boolean }>;
  apps: CodexPluginApp[];
  appTemplates: Array<{ id: string; name: string; description: string; category: string }>;
  mcpServers: string[];
  hooks: Array<{ key: string; eventName: string }>;
  scheduledTasks: Array<{ key: string; name: string; prompt: string }>;
}

export interface CodexPluginCatalog {
  plugins: CodexPluginSummary[];
  featuredPluginIds: string[];
  marketplaceErrors: Array<{ marketplacePath: string; message: string }>;
}

export interface CodexPluginInstallResult {
  appsNeedingAuth: CodexPluginApp[];
  authPolicy: string;
  runtimeRefreshed: boolean;
}

export interface CodexPluginLogo {
  light: string | null;
  dark: string | null;
}

export interface CodexChatAttachment {
  kind: 'image' | 'file';
  name: string;
  path: string;
  previewUrl?: string;
}

export interface CodexChatConfigurationRequest {
  model?: string;
  effort?: string;
  fast?: boolean;
}

export interface CheshiDesktopApi extends Partial<AppUpdateApi>, Partial<AppUpdateResumeApi>, Partial<KeepAwakeApi> {
  workspaceManagement?: WorkspaceManagementApi;
  showcase?: import('../../shared/showcase').ShowcaseApi;
  settings?: import('../../shared/settings').SettingsApi;
  appearance?: import('../../shared/window-appearance').WindowAppearanceApi;
  platform: string;
  workspaceName: string;
  userName: string;
  workspaceRoot: string;
  getWorkspaceDiskUsage?: () => Promise<import('../../shared/workspace-disk-usage').WorkspaceDiskUsage>;
  isCodeGraphIndexed: () => Promise<boolean>;
  reindexCodeGraph: () => Promise<unknown>;
  listWorkspaceDirectory: (relativePath?: string) => Promise<{
    path: string;
    entries: CheshiWorkspaceEntry[];
  }>;
  readWorkspaceFile: (relativePath: string) => Promise<WorkspaceFileReadResult>;
  openLocalFileLink?: (href: string) => Promise<void>;
  searchWorkspaceFiles: (query: string) => Promise<WorkspaceFileSearchResult>;
  localHistory: {
    list: (path: string) => Promise<LocalHistoryEntry[]>;
    read: (path: string, id: string) => Promise<LocalHistorySnapshot>;
    restore: (request: LocalHistoryRestoreRequest) => Promise<WorkspaceFileWriteResult>;
  };
  readWorkspaceFileExcerpt: (request: {
    path: string;
    line: number;
    contextLines?: number;
  }) => Promise<WorkspaceFileExcerptResult>;
  getWorkspaceFileVersion: (relativePath: string) => Promise<WorkspaceFileVersion>;
  writeWorkspaceFile: (request: WorkspaceFileWriteRequest) => Promise<WorkspaceFileWriteResult>;
  writeWorkspaceFiles: (request: { files: WorkspaceFileWriteRequest[] }) => Promise<WorkspaceFilesWriteResult>;
  createWorkspaceEntry: (request: WorkspaceEntryCreateRequest) => Promise<WorkspaceEntryCreateResult>;
  renameWorkspaceEntry: (request: WorkspaceEntryRenameRequest) => Promise<WorkspaceEntryRenameResult>;
  moveWorkspaceEntry: (request: WorkspaceEntryMoveRequest) => Promise<WorkspaceEntryMoveResult>;
  copyWorkspaceEntryFullPath: (relativePath: string) => Promise<string>;
  deleteWorkspaceEntry: (relativePath: string) => Promise<WorkspaceEntryDeleteResult>;
  onWorkspaceFilesChanged: (handler: (event: WorkspaceFilesChangedEvent) => void) => () => void;
  getGitSnapshot: () => Promise<GitRepositorySnapshot>;
  getGitBranchCommits: (branchReference: string) => Promise<GitCommitSummary[]>;
  getGitLineBlame: (request: GitLineBlameRequest) => Promise<GitLineBlame>;
  getGitLineCommit: (request: GitLineBlameRequest) => Promise<GitLineCommit>;
  getGitDiff: (request: GitDiffRequest) => Promise<GitDiffResult>;
  stageGitPaths: (paths: string[]) => Promise<GitRepositorySnapshot>;
  unstageGitPaths: (paths: string[]) => Promise<GitRepositorySnapshot>;
  prepareGitDiscard: (request: GitDiscardSelection) => Promise<GitDiscardPreview>;
  discardGitChanges: (request: GitDiscardRequest) => Promise<GitRepositorySnapshot>;
  commitGitChanges: (message: string) => Promise<GitMutationResult>;
  checkoutGitBranch: (branchName: string) => Promise<GitRepositorySnapshot>;
  createGitBranch: (branchName: string, startPoint?: string) => Promise<GitRepositorySnapshot>;
  updateGitBranch: (branchReference: string) => Promise<GitMutationResult>;
  fetchGitRepository: () => Promise<GitMutationResult>;
  pushGitCurrentBranch: () => Promise<GitMutationResult>;
  githubIssues: GitHubIssuesApi;
  listGitHubPullRequests: () => Promise<GitHubPullRequestListResult>;
  getGitHubPullRequestDetails: (number: number) => Promise<GitHubPullRequestDetails>;
  getGitHubPullRequestDiff: (number: number, commitOid?: string) => Promise<GitHubPullRequestDiffResult>;
  addGitHubPullRequestComment: (
    request: GitHubPullRequestCommentRequest,
  ) => Promise<GitHubPullRequestDetails>;
  addGitHubPullRequestReviewComment: (
    request: GitHubPullRequestReviewCommentRequest,
  ) => Promise<GitHubPullRequestDetails>;
  submitGitHubPullRequestReview: (
    request: GitHubPullRequestReviewSubmissionRequest,
  ) => Promise<GitHubPullRequestDetails>;
  createGitHubPullRequest: () => Promise<GitHubPullRequestSummary>;
  checkoutGitHubPullRequest: (number: number) => Promise<GitRepositorySnapshot>;
  mergeGitHubPullRequest: (request: GitHubPullRequestMergeRequest) => Promise<GitHubPullRequestMergeResult>;
  deleteGitHubPullRequestBranch: (number: number) => Promise<GitHubPullRequestBranchDeleteResult>;
  getGitHubPullRequestBranchCleanupStatus: (
    number: number,
  ) => Promise<GitHubPullRequestBranchCleanupStatus>;
  cleanupGitHubPullRequestBranch: (number: number) => Promise<GitHubPullRequestBranchCleanupResult>;
  openGitHubPullRequest: (url: string) => Promise<void>;
  onGitRepositoryChanged: (handler: () => void) => () => void;
  getLanguageServers: () => Promise<LanguageServerStatus[]>;
  configureLanguageServer: (request: {
    language: LanguageServerLanguage;
    mode: LanguageServerMode;
    executable?: string;
  }) => Promise<LanguageServerStatus[]>;
  selectLanguageServerExecutable: (language: LanguageServerLanguage) => Promise<{
    canceled: boolean;
    statuses: LanguageServerStatus[];
  }>;
  updateLanguageServerDocument: (request: {
    language: LanguageServerLanguage;
    path: string;
    content: string;
    version: number;
  }) => Promise<LanguageServerDocumentUpdateResult>;
  getLanguageServerCompletions: (
    request: LanguageServerFeatureRequest,
  ) => Promise<LanguageServerCompletionResult>;
  getLanguageServerHover: (
    request: LanguageServerFeatureRequest,
  ) => Promise<LanguageServerHoverResult>;
  getLanguageServerDefinitions: (
    request: LanguageServerFeatureRequest,
  ) => Promise<LanguageServerDefinitionResult>;
  getLanguageServerReferences: (
    request: LanguageServerFeatureRequest,
  ) => Promise<LanguageServerReferenceResult>;
  getLanguageServerSignatureHelp: (
    request: LanguageServerFeatureRequest,
  ) => Promise<LanguageServerSignatureHelpResult>;
  prepareLanguageServerRename: (
    request: LanguageServerFeatureRequest,
  ) => Promise<LanguageServerPrepareRenameResult>;
  renameLanguageServerSymbol: (
    request: LanguageServerFeatureRequest & { newName: string },
  ) => Promise<LanguageServerRenameResult>;
  getLanguageServerCodeActions: (
    request: LanguageServerCodeActionRequest,
  ) => Promise<LanguageServerCodeActionResult>;
  closeLanguageServerDocument: (request: {
    language: LanguageServerLanguage;
    path: string;
  }) => Promise<unknown>;
  onLanguageServerDiagnostics: (handler: (value: unknown) => void) => () => void;
  setTerminalViewVisible: (visible: boolean) => Promise<unknown>;
  setTerminalTheme: (theme: 'dark' | 'light') => Promise<unknown>;
  updateTerminalSurfaceBounds: (bounds: TerminalSurfaceBounds) => void;
  newTerminalSession: () => Promise<unknown>;
  selectTerminalSession: (sessionId: string) => Promise<unknown>;
  closeTerminalSession: (sessionId: string) => Promise<unknown>;
  selectTerminalPane: (sessionId: string, paneId: string) => Promise<unknown>;
  splitTerminalPane: (
    sessionId: string,
    paneId: string,
    direction: TerminalSplitDirection,
  ) => Promise<unknown>;
  resizeTerminalSplit: (sessionId: string, splitId: string, ratio: number) => Promise<unknown>;
  closeTerminalPane: (sessionId: string, paneId: string) => Promise<unknown>;
  onTerminalStateChanged: (handler: (value: unknown) => void) => () => void;
  getCodexAccountUsage: () => Promise<unknown>;
  codexAccounts: import('../../shared/codex-accounts').CodexAccountsApi;
  onCodexAccountUsageChanged: (handler: (value: unknown) => void) => () => void;
  listCodexChatSessions: (contextId?: string) => Promise<unknown>;
  searchCodexChatHistory: (
    request: import('../../shared/chat-history-search').ChatHistorySearchRequest,
    contextId?: string,
  ) => Promise<import('../../shared/chat-history-search').ChatHistorySearchResponse>;
  listCodexChatAgents: (contextId?: string) => Promise<unknown>;
  readCodexTurnMetrics: (threadId: string, contextId?: string) => Promise<unknown>;
  readCodexAgentDetails: (threadId: string, agentThreadIds: string[], contextId?: string) => Promise<unknown>;
  listCodexSkills: (contextId?: string) => Promise<unknown>;
  listCodexPlugins: (forceRefetch?: boolean) => Promise<CodexPluginCatalog>;
  addCodexMarketplace: (request: import('../../shared/plugin-actions').MarketplaceAddRequest) => Promise<import('../../shared/plugin-actions').MarketplaceAddResult>;
  startPluginWorkflow: (request: import('../../shared/plugin-actions').PluginWorkflowRequest, contextId?: string) => Promise<{ threadId: string; turnId: string | null }>;
  saveSkillRecording: (recording: import('../../shared/plugin-actions').SkillRecordingUpload) => Promise<import('../../shared/plugin-actions').SavedSkillRecording>;
  getCodexPluginLogo: (pluginId: string) => Promise<CodexPluginLogo>;
  readCodexPlugin: (reference: CodexPluginReference) => Promise<{ plugin: CodexPluginDetail }>;
  installCodexPlugin: (reference: CodexPluginReference) => Promise<CodexPluginInstallResult>;
  uninstallCodexPlugin: (pluginId: string) => Promise<{ runtimeRefreshed: boolean }>;
  explainCode: (request: import('../../shared/workspace-code-explanation').CodeExplanationRequest) => Promise<import('../../shared/workspace-code-explanation').CodeExplanationResult>;
  cancelCodeExplanation: (requestId: string) => Promise<void>;
  listCodexModels: (contextId?: string) => Promise<unknown>;
  temporaryChat: {
    models: (sessionId: string) => Promise<import('./features/chat/model').ChatModel[]>;
    send: (sessionId: string, request: import('../../shared/temporary-chat').TemporaryChatRequest) => Promise<import('../../shared/temporary-chat').TemporaryChatResult>;
    selectAttachments: (sessionId: string) => Promise<CodexChatAttachment[]>;
    importAttachments: (sessionId: string, files: (File | string)[]) => Promise<CodexChatAttachment[]>;
    close: (sessionId: string) => Promise<void>;
  };
  listCodexMcpServers: (contextId?: string) => Promise<unknown>;
  listCodexPermissionModes: (contextId?: string) => Promise<unknown>;
  setCodexPermissionMode: (modeId: string, contextId?: string) => Promise<unknown>;
  setCodexChatCollaborationMode: (mode: 'default' | 'plan', contextId?: string) => Promise<unknown>;
  configureCodexChat: (options: CodexChatConfigurationRequest, contextId?: string) => Promise<unknown>;
  getCodexChatStatus: (contextId?: string) => Promise<unknown>;
  getCodexChatGoal: (contextId?: string) => Promise<unknown>;
  setCodexChatGoal: (objective: string, contextId?: string) => Promise<unknown>;
  listCodexChatUserInputs: (contextId?: string) => Promise<ChatUserInputRequest[]>;
  respondCodexChatUserInput: (requestId: string, response: ChatUserInputResponse, contextId?: string) => Promise<{ requestId: string }>;
  respondCodexChatApproval: (
    approvalId: string,
    decision: 'accept' | 'acceptForSession' | 'decline',
    contextId?: string,
  ) => Promise<unknown>;
  openCodexChatSession: (sessionId: string, contextId?: string) => Promise<unknown>;
  deleteCodexChatSession: (sessionId: string, contextId?: string) => Promise<unknown>;
  openCodexChatAgent: (agentThreadId: string, contextId?: string) => Promise<unknown>;
  newCodexChatSession: (contextId?: string) => Promise<unknown>;
  forkCodexChatSession: (contextId?: string) => Promise<unknown>;
  compactCodexChatSession: (contextId?: string) => Promise<unknown>;
  reviewCodexChatSession: (contextId?: string) => Promise<unknown>;
  selectCodexChatAttachments: () => Promise<CodexChatAttachment[]>;
  appleNotes?: import('../../shared/apple-notes').AppleNotesApi;
  appleMail?: import('../../shared/apple-mail').AppleMailApi;
  appleCalendar?: import('../../shared/apple-calendar').AppleCalendarApi;
  importCodexChatAttachments: (files: (File | string)[]) => Promise<CodexChatAttachment[]>;
  getCodexChatAttachmentPreview: (attachmentPath: string) => Promise<string | null>;
  sendCodexChatMessage: (
    text: string,
    clientMessageId: string,
    skill?: CodexSkillReference | null,
    attachments?: readonly CodexChatAttachment[],
    threadId?: string | null,
    contextId?: string,
  ) => Promise<unknown>;
  steerCodexChatMessage: CheshiDesktopApi['sendCodexChatMessage'];
  cancelCodexChatResponse: (threadId?: string | null, contextId?: string) => Promise<unknown>;
  editorSession?: import('../../shared/editor-session').EditorSessionApi;
  chatQuestionDismissals: import('../../shared/chat-question-dismissals').ChatQuestionDismissalsApi;
  startCodexChatRelay: (request: import('../../shared/chat-relay').ChatRelayRequest) => Promise<import('../../shared/chat-relay').ChatRelayState>;
  stopCodexChatRelay: () => Promise<import('../../shared/chat-relay').ChatRelayState | null>;
  getCodexChatRelay: () => Promise<import('../../shared/chat-relay').ChatRelayState | null>;
  listCodexChatRelayHistory: () => Promise<import('../../shared/chat-relay').ChatRelayHistoryRecord[]>;
  deleteCodexChatRelayHistory: (id: string) => Promise<{ id: string }>;
  deleteCodexSavedTurn: (id: string) => Promise<{ id: string }>;
  listCodexSavedTurns: () => Promise<import('../../shared/chat-saved-turns').ChatSavedTurn[]>;
  saveCodexTurn: (input: import('../../shared/chat-saved-turns').ChatSavedTurnInput) => Promise<import('../../shared/chat-saved-turns').ChatSavedTurn>;
  onCodexChatRelayEvent: (handler: (state: import('../../shared/chat-relay').ChatRelayState) => void) => () => void;
  disposeCodexChatContext: (contextId: string) => Promise<void>;
  onCodexChatEvent: (handler: (value: unknown) => void, contextId?: string) => () => void;
}

type CheshiDesktopWindow = Window & {
  readonly cheshiDesktop?: CheshiDesktopApi;
};

export const cheshiDesktop = typeof window === 'undefined' ? undefined : (window as CheshiDesktopWindow).cheshiDesktop;
