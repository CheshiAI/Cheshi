import { onWindowClosed } from '../window-close-cleanup.mts';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { AGENT_CHANNELS, parseAgentAction, parseAgentEngineId, parseAgentId } from '../../shared/agent-management.ts';
import type { AgentManagementApi } from '../../shared/agent-management.ts';
import { agentText } from '../../shared/agent-management.ts';
import { AGENT_TERMINAL_CHANNELS, parseAgentTerminalBounds } from '../../shared/agent-terminal.ts';
import type { AgentTerminalManager } from './terminal.mts';

export function registerAgentManagementIpc(options: {
  window: BrowserWindow; ipc: Pick<IpcMain, 'handle' | 'removeHandler'>; service: AgentManagementApi;
  terminal?: Pick<AgentTerminalManager, 'open' | 'update' | 'close' | 'dispose'>;
}) {
  const owner = options.window.webContents;
  const channels: string[] = [];
  let disposed = false;
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (disposed || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) {
      throw new Error('Agent management is only available to its workspace window.');
    }
  };
  let unsubscribeClosed = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeClosed();
    for (const channel of channels) options.ipc.removeHandler(channel);
    options.terminal?.dispose();
  };
  const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
    options.ipc.handle(channel, (event, ...values) => { assertOwner(event); return listener(event, ...values); });
    channels.push(channel);
  };
  try {
    handle(AGENT_CHANNELS.engines, () => options.service.engines());
    handle(AGENT_CHANNELS.snapshot, (_event, engine: unknown) => options.service.snapshot(parseAgentEngineId(engine)));
    handle(AGENT_CHANNELS.details, (_event, engine: unknown, id: unknown) => options.service.details(parseAgentEngineId(engine), parseAgentId(id)));
    handle(AGENT_CHANNELS.control, (_event, engine: unknown, id: unknown, action: unknown) =>
      options.service.control(parseAgentEngineId(engine), parseAgentId(id), parseAgentAction(action)));
    if (options.terminal) {
      const terminal = options.terminal;
      handle(AGENT_TERMINAL_CHANNELS.open, (_event, engine: unknown, id: unknown) => terminal.open(parseAgentEngineId(engine), parseAgentId(id)));
      handle(AGENT_TERMINAL_CHANNELS.update, (_event, value: unknown) => terminal.update(parseAgentTerminalBounds(value)));
      handle(AGENT_TERMINAL_CHANNELS.close, (_event, id: unknown) => terminal.close(agentText(id, 100)));
    }
    unsubscribeClosed = onWindowClosed(options.window, dispose);
  } catch (error) { dispose(); throw error; }
  return { dispose };
}
