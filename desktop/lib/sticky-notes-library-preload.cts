import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { STICKY_NOTES_LIBRARY_CHANNEL as channel, type WorkspaceNotesApi } from '../shared/sticky-notes.ts';

export function createStickyNotesLibraryApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): WorkspaceNotesApi {
  const subscribe = (suffix: string, listener: () => void) => {
    const handler = (_event: IpcRendererEvent) => listener();
    ipc.on(`${channel}:${suffix}`, handler);
    return () => { ipc.removeListener(`${channel}:${suffix}`, handler); };
  };
  return {
    list: query => ipc.invoke(channel, 'list', query),
    rename: (id, title) => ipc.invoke(channel, 'rename', { id, title }), create: () => ipc.invoke(channel, 'create'),
    open: id => ipc.invoke(channel, 'open', id), deleteSelected: ids => ipc.invoke(channel, 'delete-selected', ids),
    onChanged: listener => subscribe('changed', listener),
    onOpenListRequested: listener => subscribe('open-list', listener),
  };
}
