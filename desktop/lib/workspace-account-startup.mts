import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/** Load the window concurrently, but keep account-dependent requests behind one selection. */
export function createWorkspaceAccountStartup(options: {
  ipc: Pick<IpcMain, 'handle'>;
  signal: AbortSignal;
  initialize(): Promise<unknown>;
  assertSender(event: IpcMainInvokeEvent): void;
}) {
  let initialization: Promise<unknown> | undefined;
  const aborted = new Promise<void>(resolve => {
    if (options.signal.aborted) resolve();
    else options.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const ready = async () => {
    options.signal.throwIfAborted();
    initialization ??= Promise.resolve().then(options.initialize);
    await Promise.race([initialization, aborted]);
    options.signal.throwIfAborted();
  };
  const assertSender = (event: IpcMainInvokeEvent) => {
    options.assertSender(event);
    if (event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Account request sender is no longer active.');
    }
  };
  const ipc: Pick<IpcMain, 'handle'> = {
    handle(channel, handler) {
      options.ipc.handle(channel, async (event, ...args) => {
        assertSender(event);
        await ready();
        // The renderer may close or navigate while account discovery is pending.
        assertSender(event);
        return handler(event, ...args);
      });
    },
  };
  return { ready, ipc };
}
