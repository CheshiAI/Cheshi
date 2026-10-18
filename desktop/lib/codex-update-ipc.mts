import { CODEX_UPDATE_CHANNEL, type CodexUpdateState } from '../shared/codex-update.ts';
import type { WorkspaceIpcScope } from './workspace-ipc-router.mts';
import type { CodexUpdateService } from './codex-update-service.mts';

export function registerCodexUpdateIpc(ipc: WorkspaceIpcScope['ipc'], service: CodexUpdateService) {
  ipc.handle(`${CODEX_UPDATE_CHANNEL}:get`, () => service.get());
  ipc.handle(`${CODEX_UPDATE_CHANNEL}:check`, () => service.check());
  ipc.handle(`${CODEX_UPDATE_CHANNEL}:install`, () => service.install());
  ipc.handle(`${CODEX_UPDATE_CHANNEL}:workers`, () => service.syncWorkers());
}

/** A workspace can be a retained WebContentsView, absent from BrowserWindow.getAllWindows(). */
export function attachCodexUpdateWindow(window: {
  isDestroyed(): boolean;
  webContents: { send(channel: string, state: CodexUpdateState): void };
  once(event: 'closed', listener: () => void): unknown;
  off(event: 'closed', listener: () => void): unknown;
}, service: Pick<CodexUpdateService, 'snapshot' | 'subscribe'>): () => void {
  if (window.isDestroyed()) return () => {};
  const send = (state: CodexUpdateState) => {
    if (!window.isDestroyed()) window.webContents.send(`${CODEX_UPDATE_CHANNEL}:changed`, state);
  };
  const unsubscribe = service.subscribe(send);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    window.off('closed', dispose);
  };
  window.once('closed', dispose);
  // A renderer may have read busy state before runtime.start() finished.
  send(service.snapshot());
  return dispose;
}
