import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { FLASH_MEMORY_CHANNEL, flashSourceHref, flashSourceTarget, type FlashSourceTarget } from '../../shared/flash-memory.ts';
import type { FlashMemoryStatus } from '../../shared/flash-memory.ts';

export function registerFlashMemoryIpc(ipc: Pick<IpcMain, 'handle'>,
  assertSender: (event: IpcMainInvokeEvent) => void, memory: { status(): FlashMemoryStatus; retry(): FlashMemoryStatus }, original?: (target: FlashSourceTarget) => Promise<string>): void {
  if (original) ipc.handle(`${FLASH_MEMORY_CHANNEL}:original`, (event, value: unknown) => {
    assertSender(event);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['owner', 'threadId', 'itemId'].includes(k))) throw new Error('Invalid Flash source.');
    const target = flashSourceTarget(flashSourceHref(value as FlashSourceTarget));
    if (!target) throw new Error('Invalid Flash source.');
    return original(target);
  });
  ipc.handle(`${FLASH_MEMORY_CHANNEL}:status`, event => { assertSender(event); return memory.status(); });
  ipc.handle(`${FLASH_MEMORY_CHANNEL}:retry`, event => { assertSender(event); return memory.retry(); });
}
