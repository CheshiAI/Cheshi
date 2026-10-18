import type { StatusToastMessage } from './status-toast';

export const WORKSPACE_HOST_CHANNEL = 'cheshi:workspace-host';
export interface WorkspaceNavigationState {
  homiesEnabled?: boolean;
  view: string;
  sidebarOpen: boolean;
  running: number;
  attention: boolean;
}
export interface WorkspaceHostEntry extends WorkspaceNavigationState {
  id: number;
  name: string;
  root: string;
  iconColor?: string;
}
export interface WorkspaceHostState { activeId: number | null; entries: WorkspaceHostEntry[]; }
export type WorkspaceHostCommand = { action: 'navigate'; view: string } | { action: 'sidebar' | 'manager' };
export interface WorkspaceRailOverlay {
  id: string;
  label: string;
  x: number; y: number; width: number; height: number;
  clipLeft: number; labelLeft: number;
  font: string; color: string; background: string; radius: string;
}
export interface WorkspaceRailEvent { id: string; action: 'activate' | 'dismiss'; }
export interface WorkspaceRailBlur {
  x: number; y: number; width: number; height: number; radius: number;
}
export interface WorkspaceHostLayout {
  x: number; y: number; width: number; height: number;
  viewport?: { width: number; height: number };
}
export interface WorkspaceHostApi {
  showStatusToast(message: StatusToastMessage): Promise<boolean>;
  state(): Promise<WorkspaceHostState>;
  activate(id: number): Promise<void>;
  close(id: number): Promise<void>;
  command(command: WorkspaceHostCommand): Promise<void>;
  layout(frame: WorkspaceHostLayout): Promise<void>;
  onState(listener: (state: WorkspaceHostState) => void): () => void;
  railOverlay(overlay: WorkspaceRailOverlay | null): void;
  onRailEvent(listener: (event: WorkspaceRailEvent) => void): () => void;
}
export interface WorkspaceSurfaceApi {
  onStatusToast(listener: (message: StatusToastMessage) => void): () => void;
  report(state: WorkspaceNavigationState): void;
  onRailBlur(listener: (region: WorkspaceRailBlur | null) => void): () => void;
  onCommand(listener: (command: WorkspaceHostCommand) => void): () => void;
}
declare global {
  interface Window { workspaceHost?: WorkspaceHostApi; workspaceSurface?: WorkspaceSurfaceApi; }
}
