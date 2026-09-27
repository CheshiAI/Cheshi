import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import { IMESSAGE_CHANNEL } from '../shared/imessage-notifications.ts';
import { TemporaryChatClosedError } from '../shared/temporary-chat.ts';
import { createChatNotifications } from './chat-notifications.mts';
import type { NotificationSink } from './imessage-notifications.mts';
import type { TemporaryChatService } from './temporary-chat-service.mts';
import { inputRecord } from '../shared/chat-user-input.ts';

export function createWorkspaceNotifications(options: {
  workspaceRoot: string; scope: WorkspaceIpcScope; getParent(): BrowserWindow | null; sink?: NotificationSink;
}) {
  const tracker = createChatNotifications({ workspace: path.basename(options.workspaceRoot), notify: event => options.sink?.notify(event) });
  options.scope.ipc.handle(`${IMESSAGE_CHANNEL}:queue`, (event, value: unknown) => {
    const parent = options.getParent();
    if (!parent || event.sender !== parent.webContents || event.senderFrame !== parent.webContents.mainFrame) throw new Error('Invalid queue notification owner.');
    const report = inputRecord(value);
    if (!report || typeof report.contextId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(report.contextId)
      || !Array.isArray(report.threads) || report.threads.length > 1000) throw new TypeError('Invalid queue notification state.');
    const entries = report.threads.map((value: unknown) => {
      const entry = inputRecord(value);
      if (!entry || typeof entry.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.threadId)
        || typeof entry.count !== 'number' || !Number.isSafeInteger(entry.count) || entry.count < 0 || entry.count > 10000) {
        throw new TypeError('Invalid queue count.');
      }
      return { threadId: entry.threadId, count: entry.count };
    });
    tracker.queue(report.contextId, entries);
  });
  return {
    event(context: string, event: unknown) { tracker.event(context, event); },
    remove(context: string) { tracker.remove(context); },
    temporary(service: Pick<TemporaryChatService, 'models' | 'send' | 'close'>) {
      const id = `temporary-${randomUUID()}`;
      let closed = false, sending = false;
      tracker.queue(id, []);
      return {
        models: () => service.models(),
        async send(request: unknown) {
          // A duplicate send must not change the active request's notification state.
          if (sending || closed) return service.send(request);
          sending = true; tracker.event(id, { type: 'turn-started', threadId: id });
          try {
            const result = await service.send(request);
            if (!closed) tracker.event(id, { type: 'turn-completed', threadId: id, status: 'completed' });
            return result;
          } catch (error) {
            if (!closed && !(error instanceof TemporaryChatClosedError)) tracker.event(id, { type: 'error', threadId: id });
            throw error;
          } finally { sending = false; }
        },
        async close() { closed = true; tracker.remove(id); await service.close(); },
      };
    },
    dispose() { tracker.dispose(); options.scope.ipc.removeHandler(`${IMESSAGE_CHANNEL}:queue`); },
  };
}
