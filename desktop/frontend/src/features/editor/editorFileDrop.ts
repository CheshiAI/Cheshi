import { readWorkspaceFileTransfer, WORKSPACE_FILE_TRANSFER_TYPE } from '../../shared/workspaceFileTransfer';

export const EDITOR_TAB_TRANSFER_TYPE = 'application/x-cheshi-editor-tab';
export interface EditorTabTransfer { paneId: string; path: string; }

export function acceptsEditorFileDrop(data: Pick<DataTransfer, 'types'>): boolean {
  return data.types.includes(EDITOR_TAB_TRANSFER_TYPE) || data.types.includes(WORKSPACE_FILE_TRANSFER_TYPE);
}

export function readEditorTabTransfer(data: Pick<DataTransfer, 'getData'>): EditorTabTransfer | null {
  try {
    const value: unknown = JSON.parse(data.getData(EDITOR_TAB_TRANSFER_TYPE));
    if (!value || typeof value !== 'object') return null;
    const item = value as EditorTabTransfer;
    return typeof item.paneId === 'string' && typeof item.path === 'string' ? item : null;
  } catch { return null; }
}

export function droppedWorkspacePaths(data: Pick<DataTransfer, 'getData' | 'types'>, workspaceRoot: string): string[] {
  const prefix = `${workspaceRoot.replace(/\/$/, '')}/`;
  return [...new Set(readWorkspaceFileTransfer(data).flatMap(path => {
    if (!path.startsWith(prefix)) return [];
    const relative = path.slice(prefix.length);
    if (!relative || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) return [];
    return [relative];
  }))];
}
