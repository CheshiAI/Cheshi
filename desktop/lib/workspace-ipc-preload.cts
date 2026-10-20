import type { IpcRenderer } from 'electron';
import { unwrapWorkspaceIpcResponse } from '../shared/workspace-ipc-lifecycle.ts';

export function createWorkspaceIpcRenderer(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send' | 'sendSync'>) {
  const invoke: IpcRenderer['invoke'] = async (channel, ...args: unknown[]) =>
    unwrapWorkspaceIpcResponse(await ipc.invoke(channel, ...args));
  return {
    invoke,
    on: ipc.on?.bind(ipc),
    removeListener: ipc.removeListener?.bind(ipc),
    send: ipc.send?.bind(ipc),
    sendSync: ipc.sendSync?.bind(ipc),
  };
}
