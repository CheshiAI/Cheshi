import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { EditorSessionStore } from './editor-session.mts';

export function createEditorSessionIpc(
  ipc: Pick<IpcMain, 'handle'>, directory: string, assertSender: (event: IpcMainInvokeEvent) => void,
) {
  const store = new EditorSessionStore(directory);
  ipc.handle('cheshi:read-editor-session', (event) => { assertSender(event); return store.read(); });
  ipc.handle('cheshi:save-editor-session', (event, value) => { assertSender(event); return store.save(value); });
  return store;
}
