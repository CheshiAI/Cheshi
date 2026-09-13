import type { WorkspaceTab } from './workspaceEditorModel';

export function normalizeWorkspaceEditorContent(content: string): string {
  // CodeMirror stores LF internally; file metadata preserves the original ending on save.
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function createWorkspaceFileLoadTracker() {
  let sequence = 0;
  return {
    begin: () => ++sequence,
    invalidate: () => { sequence += 1; },
    isCurrent: (request: number) => request === sequence,
  };
}

export function canApplyWorkspaceFileLoad(
  started: WorkspaceTab | undefined,
  current: WorkspaceTab | undefined,
): boolean {
  if (!started) return !current;
  return Boolean(
    current
    && current.loadGeneration === started.loadGeneration
    && current.draftContent === started.draftContent
    && current.file.revision === started.file.revision,
  );
}
