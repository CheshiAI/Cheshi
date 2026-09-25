import { cheshiDesktop } from '../../cheshiDesktop';

export type SidebarPanel = 'chats' | 'files' | 'memos';

export function normalizeSidebarPanel(value: unknown): SidebarPanel {
  return value === 'chats' || value === 'memos' ? value : 'files';
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
