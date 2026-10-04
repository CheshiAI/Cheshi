import { cheshiDesktop } from '../../cheshiDesktop';
import type { WorkspaceView } from './Sidebar';

export type SidebarPanel = 'chats' | 'files' | 'agent-chats' | 'memos' | 'github';

export function sidebarPanelForWorkspace(view: WorkspaceView, visiblePanes: readonly string[]): SidebarPanel | null {
  if (view === 'chats' && visiblePanes.includes('primary')) return 'agent-chats';
  if (view === 'notes') return 'memos';
  if (visiblePanes.includes('editor')) return 'files';
  return view === 'chat' && visiblePanes.includes('primary') ? 'chats' : null;
}

export function normalizeSidebarPanel(value: unknown): SidebarPanel {
  return value === 'chats' || value === 'agent-chats' || value === 'memos' || value === 'github' ? value : 'files';
}

function storageKey(workspaceRoot: string): string {
  return `cheshi:sidebar-panel:${workspaceRoot}`;
}

export function readSidebarPanel(workspaceRoot = cheshiDesktop?.workspaceRoot ?? ''): SidebarPanel {
  try {
    return normalizeSidebarPanel(window.localStorage.getItem(storageKey(workspaceRoot)));
  } catch {
    return 'files';
  }
}

export function saveSidebarPanel(panel: SidebarPanel, workspaceRoot = cheshiDesktop?.workspaceRoot ?? ''): void {
  try {
    window.localStorage.setItem(storageKey(workspaceRoot), panel);
  } catch {
    // Tab switching remains available when storage is unavailable.
  }
}
