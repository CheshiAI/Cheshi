import { onWindowClosed } from './window-close-cleanup.mts';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DISCORD_CHANNEL, discordPreferences, discordRecord, type DiscordConfirmation, type DiscordPreferences } from '../shared/discord.ts';
import type { createDiscordService } from './discord-service.mts';

export function registerDiscordIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  service: ReturnType<typeof createDiscordService>; setup(context: unknown): Promise<string>;
}) {
  const owner = options.window.webContents, channels: string[] = [];
  let pending: { request: DiscordConfirmation; settle(accepted: boolean): void } | null = null;
  const cancel = () => pending?.settle(false);
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('Invalid Discord settings owner.');
  };
  const handle = (name: string, action: (value: unknown) => unknown) => {
    const channel = `${DISCORD_CHANNEL}:${name}`;
    options.ipc.handle(channel, (event, value) => { assertOwner(event); return action(value); }); channels.push(channel);
  };
  let disposed = false;
  let unsubscribeClosed = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true; cancel();
    for (const channel of channels) options.ipc.removeHandler(channel);
    unsubscribeClosed();
    owner.off('did-start-loading', cancel);
    owner.off('render-process-gone', cancel);
    owner.off('destroyed', dispose);
  };
  const publish = (value: DiscordConfirmation | null) => {
    if (owner.isDestroyed()) return false;
    try { owner.send(`${DISCORD_CHANNEL}:confirmation-changed`, value); return true; }
    catch { return false; }
  };
  const confirm = (value: DiscordPreferences, signal: AbortSignal): Promise<boolean> => {
    if (disposed || pending || signal.aborted || owner.isDestroyed()) return Promise.resolve(false);
    const { guildId, ownerId, deviceName } = discordPreferences(value);
    const request = { id: randomUUID(), guildId, ownerId, deviceName };
    return new Promise(resolve => {
      const abort = () => settle(false);
      const settle = (accepted: boolean) => {
        if (pending?.request.id !== request.id) return;
        pending = null;
        signal.removeEventListener('abort', abort);
        resolve(accepted);
        publish(null);
      };
      pending = { request, settle };
      signal.addEventListener('abort', abort, { once: true });
      if (!publish(request)) { settle(false); return; }
      try { options.window.show(); options.window.focus(); }
      catch { settle(false); }
    });
  };
  try {
    handle('get', () => options.service.get()); handle('save', value => options.service.save(value));
    handle('test', () => options.service.test()); handle('setup', options.setup);
    handle('notifications', value => options.service.setNotificationsEnabled(value));
    handle('confirmation', () => pending?.request ?? null);
    handle('confirm', value => {
      const data = discordRecord(value);
      if (typeof data.accepted !== 'boolean' || !pending || data.id !== pending.request.id) throw new Error('Invalid or expired Discord confirmation.');
      pending.settle(data.accepted === true);
    });
    unsubscribeClosed = onWindowClosed(options.window, dispose);
    owner.on('did-start-loading', cancel);
    owner.on('render-process-gone', cancel);
    owner.once('destroyed', dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose, confirm };
}
