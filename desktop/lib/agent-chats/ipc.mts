import type { BrowserWindow, IpcMain } from 'electron';
import { AGENT_CHATS_CHANNEL, parseChatsRequest } from '../../shared/agent-chats.ts';
import { onWindowClosed } from '../window-close-cleanup.mts';
import type { createAgentChats } from './service.mts';
export function registerAgentChatsIpc(options: { window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>; workspaceRoot: string; service: ReturnType<typeof createAgentChats> }) {
  const owner = options.window.webContents;
  let disposed = false, unsubscribe = () => {};
  const dispose = () => { if (disposed) return; disposed = true; unsubscribe(); options.ipc.removeHandler(AGENT_CHATS_CHANNEL); };
  options.ipc.handle(AGENT_CHATS_CHANNEL, (event, value) => {
    if (disposed || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error('Chats belongs to its workspace window.');
    const request = parseChatsRequest(value);
    if (request.action === 'question' || request.action === 'question-deadline') return options.service.question(options.workspaceRoot, request);
    return request.action === 'recover' ? options.service.recover(options.workspaceRoot, request)
      : options.service.request(options.workspaceRoot, request);
  });
  unsubscribe = onWindowClosed(options.window, dispose);
  return { dispose };
}
