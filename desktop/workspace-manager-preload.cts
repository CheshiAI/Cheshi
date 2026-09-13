import { contextBridge, ipcRenderer } from 'electron';
import { installRendererReadiness } from './lib/renderer-readiness.mts';
import { createWorkspaceManagementApi } from './lib/workspace-management-preload.cts';
import { createAppUpdateApi } from './lib/app-update-preload.cts';

function argument(name: string): string {
  const flag = `--cheshi-manager-${name}`;
  const prefix = `${flag}=`;
  const value = process.argv.find((item) => item === flag || item.startsWith(prefix));
  if (!value) throw new Error('Workspace manager metadata is unavailable.');
  // Chromium serializes an explicitly empty switch without its trailing '='.
  if (value === flag) return '';
  return decodeURIComponent(value.slice(prefix.length));
}

contextBridge.exposeInMainWorld('workspaceManager', {
  platform: process.platform,
  workspaceName: argument('name'),
  workspaceRoot: argument('root'),
  api: { ...createWorkspaceManagementApi(ipcRenderer), ...createAppUpdateApi(ipcRenderer) },
});

installRendererReadiness(window, document, () => {
  void ipcRenderer.invoke('cheshi:workspace-management:content-ready').catch(() => {});
});
