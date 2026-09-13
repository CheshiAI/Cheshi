export const WORKSPACE_FILE_TRANSFER_TYPE = 'application/x-cheshi-workspace-files';

export function writeWorkspaceFileTransfer(data: Pick<DataTransfer, 'setData' | 'effectAllowed'>, path: string): void {
  data.setData(WORKSPACE_FILE_TRANSFER_TYPE, JSON.stringify([path]));
  data.effectAllowed = 'copy';
}

export function readWorkspaceFileTransfer(data: Pick<DataTransfer, 'types' | 'getData'>): string[] {
  if (!data.types.includes(WORKSPACE_FILE_TRANSFER_TYPE)) return [];
  try {
    const paths: unknown = JSON.parse(data.getData(WORKSPACE_FILE_TRANSFER_TYPE));
    if (!Array.isArray(paths) || !paths.every((path: unknown) => typeof path === 'string' && path.trim() && !path.includes('\0'))) return [];
    return paths;
  } catch {
    return [];
  }
}
