import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { CanvasLibrary } from './canvas-library.mts';
import path from 'node:path';

export function registerCanvasIpc(ipc: Pick<IpcMain, 'handle'>, root: string, assertSender: (event: IpcMainInvokeEvent) => void, dataRoot: string,
  chooseDirectory: (defaultPath: string) => Promise<string | null>) {
  const documents = new CanvasLibrary(root, dataRoot);
  const session = documents.session;
  ipc.handle('cheshi:canvas:choose-root', async event => {
    assertSender(event);
    const selected = await chooseDirectory(path.resolve(root, await session.root() ?? '.'));
    if (selected === null) return null;
    await session.selectRoot(selected);
    return documents.list();
  });
  ipc.handle('cheshi:canvas:new-path', (event, name) => { assertSender(event); return session.newPath(name); });
  ipc.handle('cheshi:canvas:rename', (event, request) => { assertSender(event); return documents.rename(request); });
  ipc.handle('cheshi:canvas:last-document', event => { assertSender(event); return session.read(); });
  ipc.handle('cheshi:canvas:remember-document', (event, path) => { assertSender(event); return session.remember(path); });
  ipc.handle('cheshi:canvas:read', (event, path) => { assertSender(event); return documents.read(path); });
  ipc.handle('cheshi:canvas:save', (event, request) => { assertSender(event); return documents.save(request); });
  ipc.handle('cheshi:canvas:list', event => { assertSender(event); return documents.list(); });
  ipc.handle('cheshi:canvas:history', (event, path) => { assertSender(event); return documents.history(path); });
  ipc.handle('cheshi:canvas:read-version', (event, path, id) => { assertSender(event); return documents.readVersion(path, id); });
  ipc.handle('cheshi:canvas:checkpoint', (event, request) => { assertSender(event); return documents.checkpoint(request); });
  ipc.handle('cheshi:canvas:restore', (event, request) => { assertSender(event); return documents.restore(request); });
  return documents;
}
