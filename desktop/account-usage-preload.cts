import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { USAGE_POPOVER_CHANNEL as channel, type UsagePopoverApi, type UsagePopoverState } from './shared/account-usage-popover';

const api: UsagePopoverApi = {
  read: () => ipcRenderer.invoke(`${channel}:read`),
  resize: height => ipcRenderer.invoke(`${channel}:resize`, height),
  action: action => ipcRenderer.invoke(`${channel}:action`, action),
  onChange(listener) {
    const receive = (_event: IpcRendererEvent, state: UsagePopoverState) => listener(state);
    ipcRenderer.on(`${channel}:changed`, receive);
    return () => { ipcRenderer.removeListener(`${channel}:changed`, receive); };
  },
};
contextBridge.exposeInMainWorld('cheshiUsagePopover', api);
