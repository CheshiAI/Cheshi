import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { HOST_TOOL_DETAILS_CHANNEL, hostToolDetailsReplyChannel } from '../../shared/host-tool-details.ts';

/** Read-only details. A response merely returns to the native approval dialog. */
export function showHostToolDetails(window: BrowserWindow, ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  agentId: string, tool: string, text: string): Promise<boolean> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(false);
  const owner = window.webContents, token = randomUUID(), channel = hostToolDetailsReplyChannel(token);
  return new Promise(resolve => {
    let finished = false;
    const finish = (back: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ipc.removeHandler(channel);
      window.removeListener('closed', cancel);
      owner.removeListener('did-start-navigation', cancel);
      owner.removeListener('render-process-gone', cancel);
      resolve(back);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, 10 * 60_000);
    timer.unref();
    ipc.handle(channel, (event: IpcMainInvokeEvent, back: unknown) => {
      if (window.isDestroyed() || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) return;
      finish(back === true);
    });
    window.once('closed', cancel);
    owner.once('did-start-navigation', cancel);
    owner.once('render-process-gone', cancel);
    try { owner.send(HOST_TOOL_DETAILS_CHANNEL, { token, agentId, tool, text }); }
    catch { cancel(); }
  });
}
