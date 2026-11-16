import { contextBridge, ipcRenderer } from 'electron';
import { createWorkspaceHostApi } from './lib/workspace-host-preload.cts';
import { createKeepAwakeApi } from './lib/keep-awake-preload.cts';
import { createWindowAppearanceApi } from './lib/window-appearance-preload.cts';
contextBridge.exposeInMainWorld('workspaceHost', createWorkspaceHostApi(ipcRenderer));
contextBridge.exposeInMainWorld('cheshiDesktop', { platform: process.platform,
  ...createKeepAwakeApi(ipcRenderer), appearance: createWindowAppearanceApi(ipcRenderer) });
