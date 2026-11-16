import type { BrowserWindow } from 'electron';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import { NOTIFICATION_EVENTS_CHANNEL } from '../shared/notification-events.ts';
import { inputRecord } from '../shared/chat-user-input.ts';

export function notificationWindowFocused(window: BrowserWindow | null): boolean {
  return Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused());
}

/** Renderer reports visible conversations; native window state decides foreground presence. */
export function createNotificationVisibility(options: {
  ipc: WorkspaceIpcScope['ipc']; getParent(): BrowserWindow | null;
}) {
  const visible = new Map<string, string>();
  const channel = `${NOTIFICATION_EVENTS_CHANNEL}:view`;
  let owner: BrowserWindow['webContents'] | undefined;
  const clear = () => visible.clear();
  const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) clear();
  };
  const detach = () => {
    owner?.off('did-start-navigation', navigate);
    owner?.off('render-process-gone', clear);
    owner?.off('destroyed', clear);
  };
  options.ipc.handle(channel, (event, value: unknown) => {
    const parent = options.getParent();
    if (!parent || parent.isDestroyed() || event.sender !== parent.webContents
      || event.senderFrame !== parent.webContents.mainFrame) throw new Error('Invalid notification visibility owner.');
    const report = inputRecord(value);
    const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
    if (!report || !validId(report.contextId) || (report.threadId !== null && !validId(report.threadId))) {
      throw new TypeError('Invalid notification visibility state.');
    }
    if (owner !== parent.webContents) {
      detach(); clear(); owner = parent.webContents;
      owner.on('did-start-navigation', navigate);
      owner.on('render-process-gone', clear);
      owner.on('destroyed', clear);
    }
    const context = report.contextId as string;
    if (report.threadId === null) visible.delete(context);
    else if (visible.has(context) || visible.size < 1000) visible.set(context, report.threadId as string);
  });
  return {
    isViewed: (thread: string) => notificationWindowFocused(options.getParent()) && [...visible.values()].includes(thread),
    remove: (context: string) => { visible.delete(context); },
    dispose() { detach(); clear(); options.ipc.removeHandler(channel); },
  };
}
