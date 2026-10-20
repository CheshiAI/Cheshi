import type { IpcRenderer } from 'electron';
import type { CanvasApi } from '../../shared/canvas.ts';

export function createCanvasApi(ipc: Pick<IpcRenderer, 'invoke'>): CanvasApi {
  return {
    chooseRoot: () => ipc.invoke('cheshi:canvas:choose-root'),
    newPath: name => ipc.invoke('cheshi:canvas:new-path', name),
    rename: request => ipc.invoke('cheshi:canvas:rename', request),
    lastDocument: () => ipc.invoke('cheshi:canvas:last-document'),
    rememberDocument: path => ipc.invoke('cheshi:canvas:remember-document', path),
    read: path => ipc.invoke('cheshi:canvas:read', path),
    save: request => ipc.invoke('cheshi:canvas:save', request),
    list: () => ipc.invoke('cheshi:canvas:list'),
    history: path => ipc.invoke('cheshi:canvas:history', path),
    readVersion: (path, id) => ipc.invoke('cheshi:canvas:read-version', path, id),
    checkpoint: request => ipc.invoke('cheshi:canvas:checkpoint', request),
    restore: request => ipc.invoke('cheshi:canvas:restore', request),
  };
}
