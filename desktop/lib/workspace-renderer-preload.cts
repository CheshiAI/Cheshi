import { contextBridge, ipcRenderer } from 'electron';
import { createWorkspaceSurfaceApi } from './workspace-host-preload.cts';
import { installRendererReadiness } from './renderer-readiness.mts';

const retainedSurface = process.argv.includes('--cheshi-workspace-surface');
if (retainedSurface) {
  contextBridge.exposeInMainWorld('workspaceSurface', createWorkspaceSurfaceApi(ipcRenderer));
}
installRendererReadiness(window, document,
  theme => ipcRenderer.send('cheshi:renderer-ready', theme), retainedSurface);
