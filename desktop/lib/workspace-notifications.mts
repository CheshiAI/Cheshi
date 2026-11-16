import path from 'node:path';
import { createWorkspaceDiscord } from './workspace-discord.mts';
import type { DiscordBridge } from './discord-service.mts';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import { IMESSAGE_CHANNEL } from '../shared/imessage-notifications.ts';
import { TemporaryChatClosedError } from '../shared/temporary-chat.ts';
import { createChatNotifications } from './chat-notifications.mts';
import type { NotificationSink } from './imessage-notifications.mts';
import type { TemporaryChatService } from './temporary-chat-service.mts';
import { inputRecord } from '../shared/chat-user-input.ts';
import { registerWorkspaceMessageCommands } from './workspace-imessage-commands.mts';
import { createNotificationVisibility, notificationWindowFocused } from './notification-visibility.mts';

export function createWorkspaceNotifications(options: {
  workspaceRoot: string; scope: WorkspaceIpcScope; getParent(): BrowserWindow | null; sink?: NotificationSink;
  discord?: DiscordBridge;
  commands?: Parameters<typeof registerWorkspaceMessageCommands>[0]['registry'];
  services?: Parameters<typeof registerWorkspaceMessageCommands>[0]['services'];
}) {
  const visibility = createNotificationVisibility({ ipc: options.scope.ipc, getParent: options.getParent });
  const tracker = createChatNotifications({ workspace: path.basename(options.workspaceRoot),
    notify: (event, _context, thread) => options.sink?.notify({ ...event, isViewed: () => visibility.isViewed(thread) }) });
  const queueCounts = new Map<string, Map<string, number>>();
  const discord = createWorkspaceDiscord({ workspace: options.workspaceRoot, bridge: options.discord,
    isViewed: visibility.isViewed,
    services: options.services ?? (() => []), queueSize: (context, thread) => queueCounts.has(context) ? queueCounts.get(context)?.get(thread) ?? 0 : null });
  const unregisterCommands = registerWorkspaceMessageCommands({ registry: options.commands, workspaceRoot: options.workspaceRoot,
    services: options.services ?? (() => []), queueSize: (context, thread) => queueCounts.get(context)?.get(thread) ?? 0 });
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
    queueCounts.set(report.contextId, new Map(entries.map(entry => [entry.threadId, entry.count])));
    discord.queue(report.contextId);
  });
  return {
    setupDiscord: discord.setup,
    event(context: string, event: unknown) { tracker.event(context, event); discord.event(context, event); },
    remove(context: string) { tracker.remove(context); queueCounts.delete(context); discord.remove(context); visibility.remove(context); },
    temporary(service: Pick<TemporaryChatService, 'models' | 'send' | 'close'>, window?: BrowserWindow) {
      const id = `temporary-${randomUUID()}`;
      let closed = false, sending = false;
      const temporaryTracker = createChatNotifications({ workspace: path.basename(options.workspaceRoot),
        notify: event => options.sink?.notify({ ...event, isViewed: () => closed || notificationWindowFocused(window ?? null) }) });
      temporaryTracker.queue(id, []);
      return {
        models: () => service.models(),
        async send(request: unknown) {
          // A duplicate send must not change the active request's notification state.
          if (sending || closed) return service.send(request);
          sending = true; temporaryTracker.event(id, { type: 'turn-started', threadId: id });
          try {
            const result = await service.send(request);
            if (!closed) temporaryTracker.event(id, { type: 'turn-completed', threadId: id, status: 'completed' });
            return result;
          } catch (error) {
            if (!closed && !(error instanceof TemporaryChatClosedError)) temporaryTracker.event(id, { type: 'error', threadId: id });
            throw error;
          } finally { sending = false; }
        },
        async close() { closed = true; temporaryTracker.dispose(); await service.close(); },
      };
    },
    dispose() { visibility.dispose(); discord.dispose(); unregisterCommands(); tracker.dispose(); queueCounts.clear(); options.scope.ipc.removeHandler(`${IMESSAGE_CHANNEL}:queue`); },
  };
}
