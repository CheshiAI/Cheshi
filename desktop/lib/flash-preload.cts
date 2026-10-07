import type { IpcRenderer } from 'electron';
import { FLASH_MEMORY_CHANNEL, type FlashMemoryApi } from '../shared/flash-memory.ts';

export function createFlashMemoryApi(ipc: Pick<IpcRenderer, 'invoke'>): FlashMemoryApi {
  return {
    status: () => ipc.invoke(`${FLASH_MEMORY_CHANNEL}:status`),
    retry: () => ipc.invoke(`${FLASH_MEMORY_CHANNEL}:retry`),
  };
}
