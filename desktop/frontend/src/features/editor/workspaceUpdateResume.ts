import type { WorkspaceFileReadResult, WorkspaceFileVersion } from '../../cheshiDesktop';
import { resumeRecord } from '../shell/updateWorkspaceResume';
import type { WorkspaceTab } from './workspaceEditorModel';

export interface EditorUpdateSnapshot {
  tabs: Array<Pick<WorkspaceTab, 'path' | 'file' | 'savedContent' | 'draftContent' | 'conflictMessage'>>;
  selectedPath: string | null;
  problemsOpen: boolean;
  problemsRatio: number;
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
    && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..');
}

function validFile(value: unknown, path: string): value is WorkspaceFileVersion {
  const file = resumeRecord(value);
  return !!file && file.path === path && file.kind === 'file' && typeof file.name === 'string'
    && ['text', 'image', 'binary', 'too_large'].includes(String(file.fileKind))
    && typeof file.revision === 'string' && typeof file.hasBom === 'boolean'
    && ['lf', 'crlf', 'cr'].includes(String(file.lineEnding))
    && typeof file.size === 'number' && Number.isFinite(file.size)
    && typeof file.modifiedAt === 'number' && Number.isFinite(file.modifiedAt);
}

export function parseEditorUpdateSnapshot(value: unknown): EditorUpdateSnapshot {
  const record = resumeRecord(value);
  if (!record || !Array.isArray(record.tabs) || record.tabs.length > 500
    || (record.selectedPath !== null && !validPath(record.selectedPath))
    || typeof record.problemsOpen !== 'boolean' || typeof record.problemsRatio !== 'number'
    || !Number.isFinite(record.problemsRatio) || record.problemsRatio < 0 || record.problemsRatio > 1) {
    throw new Error('The saved editor workspace is invalid.');
  }
  const seen = new Set<string>();
  for (const value of record.tabs) {
    const tab = resumeRecord(value);
    if (!tab || !validPath(tab.path) || seen.has(tab.path) || !validFile(tab.file, tab.path)
      || typeof tab.savedContent !== 'string' || typeof tab.draftContent !== 'string'
      || (tab.conflictMessage !== null && typeof tab.conflictMessage !== 'string')) {
      throw new Error('A saved editor tab is invalid.');
    }
    seen.add(tab.path);
  }
  if (record.selectedPath !== null && !seen.has(record.selectedPath)) throw new Error('The selected editor tab is missing.');
  return record as unknown as EditorUpdateSnapshot;
}

export function captureEditorUpdateSnapshot(
  tabs: readonly WorkspaceTab[], selectedPath: string | null, problemsOpen: boolean, problemsRatio: number,
): EditorUpdateSnapshot {
  return {
    tabs: tabs.map(({ path, file, savedContent, draftContent, conflictMessage }) => ({
      path, file, savedContent, draftContent, conflictMessage,
    })), selectedPath, problemsOpen, problemsRatio,
  };
}

export async function restoreEditorUpdateTabs(
  snapshot: EditorUpdateSnapshot,
  read: (path: string) => Promise<WorkspaceFileReadResult>,
  generation: () => number,
): Promise<WorkspaceTab[]> {
  return Promise.all(snapshot.tabs.map(async (saved): Promise<WorkspaceTab> => {
    const dirty = saved.savedContent !== saved.draftContent;
    const base = { ...saved, previewDataUrl: null, sourceExcerpt: null, loadGeneration: generation() };
    try {
      const result = await read(saved.path);
      if (dirty) {
        // Retain the original revision AND original contents. Updating the baseline could
        // let a later save overwrite an external edit made while the app was restarting.
        return { ...base, conflictMessage: saved.conflictMessage ?? (result.file.revision !== saved.file.revision
          ? 'This file changed during the update. Your draft is preserved; review it before reloading.' : null) };
      }
      const content = (result.content ?? '').replace(/\r\n?/g, '\n');
      return { ...base, file: result.file, previewDataUrl: result.dataUrl, savedContent: content,
        draftContent: content, conflictMessage: null };
    } catch {
      return { ...base, conflictMessage: 'This file could not be read after the update. Its saved editor contents are preserved.' };
    }
  }));
}

export function editorDraftsMatch(snapshot: EditorUpdateSnapshot | null, tabs: readonly WorkspaceTab[]): boolean {
  if (!snapshot) return false;
  return tabs.every((tab) => tab.draftContent === tab.savedContent || snapshot.tabs.some((saved) =>
    saved.path === tab.path && saved.draftContent === tab.draftContent && saved.savedContent === tab.savedContent));
}
