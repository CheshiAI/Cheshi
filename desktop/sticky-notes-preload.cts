import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { STICKY_NOTES_CHANNEL as channel, type StickyNotesApi } from './shared/sticky-notes.ts';

const invoke = <T,>(action: string, value?: unknown): Promise<T> => ipcRenderer.invoke(channel, action, value);
function subscribe<T>(suffix: string, listener: (value: T) => void) {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(`${channel}:${suffix}`, handler);
  return () => { ipcRenderer.removeListener(`${channel}:${suffix}`, handler); };
}
const api: StickyNotesApi = {
  read: () => invoke('read'), save: content => invoke('save', content), list: () => invoke('list'),
  create: () => invoke('create'), open: id => invoke('open', id), pin: enabled => invoke('pin', enabled),
  close: () => invoke('close'), delete: () => invoke('delete'),
  deleteSelected: ids => invoke('delete-selected', ids), onChanged: listener => subscribe('changed', listener),
  acknowledge: (token, error) => invoke('acknowledge', { token, error }),
  onRequest: listener => subscribe('request', listener),
  appearance: () => invoke('appearance'), onAppearance: listener => subscribe('appearance', listener),
};
contextBridge.exposeInMainWorld('cheshiStickyNotes', api);
