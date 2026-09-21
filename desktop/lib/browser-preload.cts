import type { IpcRenderer } from 'electron';
import { createShowcaseApi } from './showcase-preload.cts';

export function createBrowserApis(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  return { showcase: createShowcaseApi(ipc) };
}
