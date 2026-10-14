import type { IpcRenderer } from 'electron';
import { WORKSPACE_HOST_CHANNEL as channel } from '../shared/workspace-host.ts';
import type { WorkspaceHostApi, WorkspaceSurfaceApi } from '../shared/workspace-host.ts';

export function createWorkspaceHostApi(ipc: IpcRenderer): WorkspaceHostApi {
  return {
    state: () => ipc.invoke(`${channel}:state`),
    activate: id => ipc.invoke(`${channel}:activate`, id),
    close: id => ipc.invoke(`${channel}:close`, id),
    command: command => ipc.invoke(`${channel}:command`, command),
    layout: frame => ipc.invoke(`${channel}:layout`, frame),
    railOverlay: overlay => ipc.send(`${channel}:rail-overlay`, overlay),
    onRailEvent: listener => {
      const receive = (_event: unknown, value: Parameters<typeof listener>[0]) => listener(value);
      ipc.on(`${channel}:rail-event`, receive);
      return () => { ipc.off(`${channel}:rail-event`, receive); };
    },
    onState: listener => {
      const receive = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
      ipc.on(`${channel}:changed`, receive);
      return () => { ipc.off(`${channel}:changed`, receive); };
    },
  };
}
export function createWorkspaceSurfaceApi(ipc: IpcRenderer): WorkspaceSurfaceApi {
  return {
    report: state => ipc.send(`${channel}:report`, state),
    onRailBlur: listener => {
      const receive = (_event: unknown, region: Parameters<typeof listener>[0]) => listener(region);
      ipc.on(`${channel}:rail-blur`, receive);
      return () => { ipc.off(`${channel}:rail-blur`, receive); };
    },
    onCommand: listener => {
      const receive = (_event: unknown, command: Parameters<typeof listener>[0]) => listener(command);
      ipc.on(`${channel}:command`, receive);
      return () => { ipc.off(`${channel}:command`, receive); };
    },
  };
}
