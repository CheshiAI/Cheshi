import { createSchedulerApi } from './scheduler-preload.cts';
import { createDiscordApi } from './discord-preload.cts';
import { createNotificationEventsApi } from './notification-events-preload.cts';
import { createWindowAppearanceApi } from './window-appearance-preload.cts';
import { createGitLineBlameApi } from './git-line-blame-preload.cts';
import type { IpcRenderer } from 'electron';
import { createSettingsApi } from './settings-preload.cts';
import { createAppleCalendarApi } from './apple-calendar-preload.cts';
import { createAgentManagementApi } from './agent-management-preload.cts';
import { createAgentTerminalApi } from './agent-terminal-preload.cts';
import { createAgentRegistryApi } from './agent-registry-preload.cts';

export function createWorkspaceFeatureApis(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  return {
    scheduler: createSchedulerApi(ipc), appearance: createWindowAppearanceApi(ipc), discord: createDiscordApi(ipc),
    notificationEvents: createNotificationEventsApi(ipc),
    ...createGitLineBlameApi(ipc), settings: createSettingsApi(ipc),
    appleCalendar: createAppleCalendarApi(ipc, process.platform),
    agentManagement: { ...createAgentManagementApi(ipc), terminal: createAgentTerminalApi(ipc) },
    agentRegistry: createAgentRegistryApi(ipc),
  };
}
