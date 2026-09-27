import type { IpcRenderer } from 'electron';
import { NOTIFICATION_EVENTS_CHANNEL, parseNotificationEventSettings, type NotificationEventsApi } from '../shared/notification-events.ts';

export function createNotificationEventsApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): NotificationEventsApi {
  return {
    reportView: (contextId, threadId) => ipc.invoke(`${NOTIFICATION_EVENTS_CHANNEL}:view`, { contextId, threadId }),
    get: async () => parseNotificationEventSettings(await ipc.invoke(`${NOTIFICATION_EVENTS_CHANNEL}:get`)),
    set: async (kind, enabled) => parseNotificationEventSettings(await ipc.invoke(`${NOTIFICATION_EVENTS_CHANNEL}:set`, kind, enabled)),
    onChanged: listener => {
      const handler = (_event: unknown, value: unknown) => listener(parseNotificationEventSettings(value));
      ipc.on(`${NOTIFICATION_EVENTS_CHANNEL}:changed`, handler);
      return () => { ipc.removeListener(`${NOTIFICATION_EVENTS_CHANNEL}:changed`, handler); };
    },
  };
}
