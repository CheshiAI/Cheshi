export type WorkspaceFileKind = "text" | "image" | "binary" | "too_large";

export type WorkspaceLineEnding = "lf" | "crlf" | "cr";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  fileKind?: WorkspaceFileKind;
  size: number;
  modifiedAt: number;
  revision: string;
}

export interface WorkspaceFileVersion extends WorkspaceFileEntry {
  kind: "file";
  fileKind: WorkspaceFileKind;
  hasBom: boolean;
  lineEnding: WorkspaceLineEnding;
}

export interface WorkspaceFileReadResult {
  file: WorkspaceFileVersion;
  content: string | null;
  dataUrl: string | null;
}

export interface WorkspaceFileExcerptRequest {
  path: string;
  line: number;
  contextLines?: number;
}

export interface WorkspaceFileExcerptResult {
  file: WorkspaceFileVersion;
  content: string;
  startLine: number;
  endLine: number;
  targetLine: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface WorkspaceFileWriteRequest {
  path: string;
  content: string;
  expectedRevision: string;
  hasBom?: boolean;
  lineEnding?: WorkspaceLineEnding;
}

export interface WorkspaceFileWriteResult {
  status: "written" | "conflict";
  file: WorkspaceFileVersion;
}

export interface WorkspaceFilesWriteRequest {
  files: WorkspaceFileWriteRequest[];
}

export interface WorkspaceFilesWriteResult {
  status: "written" | "conflict";
  files: WorkspaceFileVersion[];
}

export interface WorkspaceEntryLocation {
  path: string;
  absolutePath: string;
}

export interface WorkspaceFilesChangedEvent {
  paths: string[];
  overflow: boolean;
}

export type WorkspaceFileWatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

export interface WorkspaceFileWatcher {
  on(event: "error", listener: (error: Error) => void): WorkspaceFileWatcher;
  close(): void;
}

export type WorkspaceFileWatcherFactory = (
  directory: string,
  options: { recursive: true },
  listener: WorkspaceFileWatchListener,
) => WorkspaceFileWatcher;

export interface WorkspaceFileWatchOptions {
  debounceMs?: number;
  pathLimit?: number;
  onError?: (error: Error) => void;
  watcherFactory?: WorkspaceFileWatcherFactory;
}

export interface WorkspaceEntryCreateRequest {
  directoryPath: string;
  name: string;
  kind: "file" | "directory";
}

export interface WorkspaceEntryCreateResult {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceEntryRenameRequest {
  path: string;
  newName: string;
}

export interface WorkspaceEntryRenameResult {
  previousPath: string;
  path: string;
}

export interface WorkspaceEntryMoveRequest {
  path: string;
  destinationDirectory: string;
}

export interface WorkspaceEntryMoveResult {
  previousPath: string;
  path: string;
}

export interface WorkspaceRoot {
  requested: string;
  resolved: string;
}

export interface WorkspaceStats {
  size: number;
  modifiedAt: number;
  mode: number;
  dev: number;
  ino: number;
  revision: string;
}
