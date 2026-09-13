import type { WorkspaceManagementApi } from '../../shared/workspace-management';

export interface WorkspaceManagerEnvironment {
  platform: string;
  workspaceName: string;
  workspaceRoot: string;
  api: WorkspaceManagementApi;
}

export const workspaceManager = (window as Window & {
  readonly workspaceManager?: WorkspaceManagerEnvironment;
}).workspaceManager;
