import { createSaveActions as createOriginalSaveActions } from '../../../../vendor/open-pencil/src/app/document/io/save/actions';
import { requestHost } from './host';

type Options = Parameters<typeof createOriginalSaveActions>[0];

/** Preserve upstream content revisions/recovery while writing through workspace IPC. */
export function createSaveActions(options: Options) {
  const original = createOriginalSaveActions(options);
  async function writeFile(data: Uint8Array, version: number): Promise<boolean> {
    if (options.getStorageBinding()) return original.writeFile(data, version);
    const path = options.getFilePath();
    if (!path) return false;
    await requestHost('save', { path, data });
    options.setSavedVersion(version);
    options.setLastWriteTime(Date.now());
    await options.onWriteSuccess?.(version);
    return true;
  }
  async function save(as: boolean) {
    if (options.getStorageBinding() && !as) return original.saveFigFile();
    const current = options.getFilePath();
    const path = as || !current
      ? await requestHost<string | null>('save-path', { suggested: current ?? `${options.state.documentName || 'design'}.fig` })
      : current;
    if (!path) return false;
    const version = options.version();
    const data = await options.buildFigFile();
    await requestHost('save', { path, data });
    options.setFilePath(path); options.setFileHandle(null); options.setStorageBinding(null);
    options.setSourceIdentity({ path, handle: null });
    options.state.documentName = path.split('/').at(-1)!.replace(/\.fig$/i, '');
    options.setSavedVersion(version); options.setLastWriteTime(Date.now());
    await options.onWriteSuccess?.(version);
    return true;
  }
  return { writeFile, saveFigFile: () => save(false), saveFigFileAs: () => save(true) };
}
