export interface CanvasDocument {
  path: string;
  revision: string;
  data: Uint8Array;
}

export interface CanvasSaveRequest {
  path: string;
  expectedRevision: string | null;
  data: Uint8Array;
  description?: string;
}

export type CanvasVersionReason = 'opened' | 'saved' | 'external' | 'checkpoint' | 'before-restore' | 'restored';
export interface CanvasVersion {
  id: string;
  revision: string;
  createdAt: string;
  description: string;
  reason: CanvasVersionReason;
  size: number;
}
export interface CanvasLibraryListing {
  workspaceRoot: string;
  canvasRoot: string | null;
  historyDirectory: string;
  files: { path: string; size: number; modifiedAt: number }[];
  truncated: boolean;
  relocations?: CanvasFileRelocation[];
}
export interface CanvasFileRelocation { previousPath: string; path: string }
export interface CanvasVersionHistory {
  path: string;
  currentRevision: string | null;
  versions: CanvasVersion[];
}
export interface CanvasRestoreRequest {
  path: string;
  versionId: string;
  expectedRevision: string | null;
}

export interface CanvasApi {
  chooseRoot(): Promise<CanvasLibraryListing | null>;
  newPath(name: string): Promise<string>;
  rename(request: CanvasRenameRequest): Promise<CanvasRenamedDocument>;
  lastDocument(): Promise<string | null>;
  rememberDocument(path: string | null): Promise<void>;
  read(path: string): Promise<CanvasDocument>;
  save(request: CanvasSaveRequest): Promise<{ path: string; revision: string }>;
  list(): Promise<CanvasLibraryListing>;
  history(path: string): Promise<CanvasVersionHistory>;
  readVersion(path: string, versionId: string): Promise<CanvasDocument>;
  checkpoint(request: { path: string; description: string }): Promise<CanvasVersion>;
  restore(request: CanvasRestoreRequest): Promise<CanvasDocument>;
}

export interface CanvasRenameRequest {
  path: string;
  name: string;
  expectedRevision?: string;
}
export interface CanvasRenamedDocument {
  previousPath: string;
  path: string;
  revision: string;
}

export function canvasFileName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a canvas file name.');
  const name = value.trim().replace(/\.fig$/i, '');
  if (!name || name === '.' || name === '..' || /[\\/\\\\\x00-\x1f]/.test(name) || name.length > 200) {
    throw new Error('Enter a file name without folders, up to 200 characters.');
  }
  return `${name}.fig`;
}
