import { createWindowAppearanceApi } from './window-appearance-preload.cts';
import { createGitLineBlameApi } from './git-line-blame-preload.cts';
import type { IpcRenderer } from 'electron';
import { createSettingsApi } from './settings-preload.cts';
import { createAppleMailApi } from './apple-mail-preload.cts';
import { createAppleCalendarApi } from './apple-calendar-preload.cts';

export function createWorkspaceFeatureApis(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  return {
    appearance: createWindowAppearanceApi(ipc),
    ...createGitLineBlameApi(ipc), settings: createSettingsApi(ipc),
    appleMail: createAppleMailApi(ipc, process.platform),
    appleCalendar: createAppleCalendarApi(ipc, process.platform),
  };
}
