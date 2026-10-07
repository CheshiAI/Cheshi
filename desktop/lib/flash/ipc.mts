import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { FLASH_MEMORY_CHANNEL } from '../../shared/flash-memory.ts';
import type { FlashMemoryStatus } from '../../shared/flash-memory.ts';

export function registerFlashMemoryIpc(ipc: Pick<IpcMain, 'handle'>,
  assertSender: (event: IpcMainInvokeEvent) => void, memory: { status(): FlashMemoryStatus; retry(): FlashMemoryStatus }): void {
  ipc.handle(`${FLASH_MEMORY_CHANNEL}:status`, event => { assertSender(event); return memory.status(); });
  ipc.handle(`${FLASH_MEMORY_CHANNEL}:retry`, event => { assertSender(event); return memory.retry(); });
}
