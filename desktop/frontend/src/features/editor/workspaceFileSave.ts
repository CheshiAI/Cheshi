import type { WorkspaceFileWriteResult } from '../../cheshiDesktop';
import type { WorkspaceTab } from './workspaceEditorModel';

export function canSaveWorkspaceTab(tab: WorkspaceTab | undefined, saving: boolean): tab is WorkspaceTab {
  return Boolean(
    tab
    && tab.file.fileKind === 'text'
    && tab.draftContent !== tab.savedContent
    && !tab.conflictMessage
    && !saving,
  );
}

export function applyWorkspaceFileSaveResult(
  current: WorkspaceTab,
  submitted: Pick<WorkspaceTab, 'draftContent' | 'loadGeneration'>,
  response: WorkspaceFileWriteResult,
): WorkspaceTab {
  if (current.loadGeneration !== submitted.loadGeneration) return current;
  if (response.status === 'conflict') {
    return {
      ...current,
      file: response.file,
      conflictMessage: 'The file changed on disk. Your draft is preserved; reload it before saving again.',
    };
  }
  return {
    ...current,
    file: response.file,
    savedContent: submitted.draftContent,
    conflictMessage: null,
  };
}
