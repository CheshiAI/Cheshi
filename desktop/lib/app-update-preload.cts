import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { APP_UPDATE_CHANNEL, type AppUpdateApi, type AppUpdateResumeApi, type AppUpdateState } from '../shared/app-update.ts';

export function createAppUpdateApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): AppUpdateApi & AppUpdateResumeApi {
  const subscribe = <T,>(suffix: string, listener: (value: T) => void) => {
    const channel = `${APP_UPDATE_CHANNEL}:${suffix}`;
    const handler = (_event: IpcRendererEvent, value: T) => listener(value);
    ipc.on(channel, handler);
    return () => { ipc.removeListener(channel, handler); };
  };
  return {
    getAppUpdate: () => ipc.invoke(`${APP_UPDATE_CHANNEL}:get`),
    onAppUpdate: listener => subscribe<AppUpdateState>('changed', listener),
    installAppUpdate: () => ipc.invoke(`${APP_UPDATE_CHANNEL}:install`),
    openAppRelease: () => ipc.invoke(`${APP_UPDATE_CHANNEL}:open`),
    getUpdateResume: () => ipc.invoke(`${APP_UPDATE_CHANNEL}:resume`),
    saveUpdateResume: snapshot => ipc.invoke(`${APP_UPDATE_CHANNEL}:save`, snapshot),
    clearUpdateResume: () => ipc.invoke(`${APP_UPDATE_CHANNEL}:clear`),
    onPrepareAppUpdate: listener => subscribe<string>('prepare', listener),
    onAppUpdateCommitted: listener => subscribe<string>('committed', listener),
    acknowledgeAppUpdate: (requestId, error) => ipc.invoke(`${APP_UPDATE_CHANNEL}:ack`, requestId, error),
    onAppUpdatePreparationCancelled: listener => subscribe<undefined>('cancelled', listener),
  };
}
