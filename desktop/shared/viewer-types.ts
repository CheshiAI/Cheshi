/**
 * Shared Viewer contracts used by the HTTP backend and the frontend.
 *
 * Keep these transport types outside either implementation so the UI does
 * not need to import a backend module just to describe a diff response.
 */
export type WorkspaceDiffMode = 'uncommitted' | 'base';
export type WorkspaceDiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
export type WorkspaceDiffLineKind = 'add' | 'remove' | 'context' | 'header';

export interface WorkspaceDiffLine {
  kind: WorkspaceDiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface WorkspaceDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: WorkspaceDiffLine[];
}

export interface WorkspaceDiffFile {
  path: string;
  oldPath: string | null;
  status: WorkspaceDiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: WorkspaceDiffHunk[];
}

export interface WorkspaceDiffResult {
  mode: WorkspaceDiffMode;
  baseRef: string | null;
  files: WorkspaceDiffFile[];
  tooLarge: boolean;
}
