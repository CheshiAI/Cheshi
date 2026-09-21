import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, Shell } from 'electron';
import { localFileLinkPath } from '../shared/local-file-link.ts';

export function registerLocalFileLinkIpc(options: {
  ipcMain: Pick<IpcMain, 'handle'>;
  workspaceRoot: string;
  assertSender(event: IpcMainInvokeEvent): void;
  shell: Pick<Shell, 'openPath'>;
}) {
  options.ipcMain.handle('cheshi:open-local-file-link', async (event, href: unknown) => {
    options.assertSender(event);
    const filePath = localFileLinkPath(href);
    if (!filePath) throw new TypeError('Invalid local file link.');
    const absolutePath = resolve(options.workspaceRoot, filePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error('The link does not point to a file.');
    const error = await options.shell.openPath(absolutePath);
    if (error) throw new Error(error);
  });
}
