import { createGitLineBlameApi } from './git-line-blame-preload.cts';
import type { IpcRenderer } from 'electron';
import { createBrowserApis } from './browser-preload.cts';
import { createSettingsApi } from './settings-preload.cts';

export function createWorkspaceFeatureApis(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  return { ...createGitLineBlameApi(ipc), ...createBrowserApis(ipc), settings: createSettingsApi(ipc) };
}
