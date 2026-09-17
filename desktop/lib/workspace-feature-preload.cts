import type { IpcRenderer } from 'electron';
import { createBrowserApis } from './browser-preload.cts';
import { createSettingsApi } from './settings-preload.cts';

export function createWorkspaceFeatureApis(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  return { ...createBrowserApis(ipc), settings: createSettingsApi(ipc) };
}
