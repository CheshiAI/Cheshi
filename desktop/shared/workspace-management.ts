export interface WorkspaceCatalogEntry {
  id: string;
  name: string;
  rootPath: string;
  available: boolean;
  /** Omitted capability metadata is unknown; Git actions require literal true. */
  isGitRepository?: boolean;
}

export interface WorkspaceCatalog {
  workspaces: WorkspaceCatalogEntry[];
}

export interface WorkspaceCreateProjectRequest {
  parentPath: string;
  directoryName: string;
}

export interface WorkspaceCloneRequest {
  url: string;
  githubRepository?: string;
  parentPath: string;
  directoryName: string;
  depth?: number;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
}

export interface GitHubRepositoryPage {
  repositories: GitHubRepository[];
  nextPage: number | null;
  login: string;
}

/** IPC represents missing authentication without rejecting the Electron handler. */
export type GitHubRepositoryListResponse =
  | { status: 'ready'; page: GitHubRepositoryPage }
  | { status: 'authentication-required' };

export interface GitHubLoginState {
  state: 'idle' | 'starting' | 'waiting' | 'complete' | 'error';
  userCode: string | null;
  error: string | null;
}

export interface WorkspaceCreateWorktreeRequest {
  repositoryPath: string;
  branch: string;
  baseRef: string;
  directoryName: string;
}

export interface WorkspaceWorktree {
  path: string;
  branch: string | null;
  isCurrent: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorkspaceToolStatus {
  platform: string;
  brew: boolean;
  gh: boolean;
  codex: boolean;
  /** Optional shell customization; omitted means its installation is unknown. */
  ohMyZsh?: boolean;
}

export interface WorkspaceCodexLoginState {
  state: 'checking' | 'signed_out' | 'signing_in' | 'signed_in' | 'error';
  error: string | null;
}

export interface WorkspaceManagementApi {
  getCodexLogin(): Promise<WorkspaceCodexLoginState>;
  startCodexLogin(): Promise<WorkspaceCodexLoginState>;
  cancelCodexLogin(): Promise<WorkspaceCodexLoginState>;
  getToolStatus(): Promise<WorkspaceToolStatus>;
  openManager(): Promise<void>;
  list(): Promise<WorkspaceCatalog>;
  chooseDirectory(): Promise<string | null>;
  addFolder(path: string): Promise<WorkspaceCatalogEntry>;
  createProject(request: WorkspaceCreateProjectRequest): Promise<WorkspaceCatalogEntry>;
  deleteWorkspace(id: string): Promise<boolean>;
  clone(request: WorkspaceCloneRequest): Promise<WorkspaceCatalogEntry>;
  listGitHubRepositories(page?: number): Promise<GitHubRepositoryPage>;
  startGitHubLogin(): Promise<GitHubLoginState>;
  getGitHubLogin(): Promise<GitHubLoginState>;
  cancelGitHubLogin(): Promise<void>;
  openGitHubLoginBrowser(): Promise<void>;
  listWorktrees(repositoryPath: string): Promise<WorkspaceWorktree[]>;
  createWorktree(request: WorkspaceCreateWorktreeRequest): Promise<WorkspaceCatalogEntry>;
  open(path: string): Promise<void>;
  openCurrent(path: string): Promise<void>;
}
