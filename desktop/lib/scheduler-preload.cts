import type { IpcRenderer } from 'electron';
import { SCHEDULER_CHANNEL, SCHEDULER_CHANGED_CHANNEL, type SchedulerApi } from '../shared/scheduler.ts';

export function createSchedulerApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): SchedulerApi {
  let sequence = 0;
  const invoke = (method: string, value?: unknown, extra?: unknown) => ipc.invoke(SCHEDULER_CHANNEL, method, value, extra);
  return {
    startup: () => invoke('startup'), setStartup: enabled => invoke('set-startup', enabled),
    migrate: (id, revision, calendarId) => invoke('migrate', { id, revision }, calendarId),
    onChanged(listener, onError) {
      const token = `${Date.now()}:${++sequence}`;
      let active = true;
      const changed = () => { if (active) listener(); };
      ipc.on(SCHEDULER_CHANGED_CHANNEL, changed);
      // Refresh after registration so changes during initial loading cannot be lost.
      void invoke('subscribe', token).then(changed).catch(error => {
        if (active) onError?.(error instanceof Error ? error.message : String(error));
      });
      return () => {
        active = false; ipc.removeListener(SCHEDULER_CHANGED_CHANNEL, changed);
        void invoke('unsubscribe', token).catch(() => {});
      };
    },
    read: () => invoke('read'), save: (input, target) => invoke('save', input, target),
    remove: (id, revision) => invoke('remove', { id, revision }), setAuto: enabled => invoke('auto', enabled),
    setNotificationPosition: position => invoke('notification-position', position),
    act: (id, action) => invoke('act', id, action),
    respondApproval: (runId, id, decision) => invoke('approval', runId, { id, decision }),
    respondInput: (runId, id, response) => invoke('input', runId, { id, response }),
  };
}
