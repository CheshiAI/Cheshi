import { describe, expect, it } from 'bun:test';
import { EditorState } from '@codemirror/state';

import { applyWorkspaceFileSaveResult, canSaveWorkspaceTab } from '../frontend/src/features/editor/workspaceFileSave';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';

function createTab(): WorkspaceTab {
  return {
    path: 'a.ts',
    file: {
      path: 'a.ts', name: 'a.ts', kind: 'file', fileKind: 'text', size: 0,
      modifiedAt: 0, revision: 'initial', hasBom: false, lineEnding: 'lf',
    },
    previewDataUrl: null,
    sourceExcerpt: null,
    savedContent: 'initial',
    draftContent: 'submitted',
    conflictMessage: null,
    loadGeneration: 0,
    editorState: EditorState.create({ doc: 'submitted' }),
  };
}

describe('workspace file save completion', () => {
  it('keeps typing after the submitted snapshot dirty and preserves its editor state', () => {
    const submitted = createTab();
    const current = {
      ...submitted,
      draftContent: 'typed while saving',
      editorState: EditorState.create({ doc: 'typed while saving' }),
    };
    const saved = applyWorkspaceFileSaveResult(current, submitted, {
      status: 'written', file: { ...submitted.file, revision: 'saved' },
    });
    expect(saved.savedContent).toBe('submitted');
    expect(saved.draftContent).toBe('typed while saving');
    expect(saved.editorState).toBe(current.editorState);
    expect(canSaveWorkspaceTab(saved, false)).toBe(true);
  });

  it('updates only the saved tab while another tab is active', () => {
    const submitted = createTab();
    const other = { ...createTab(), path: 'b.ts', editorState: EditorState.create({ doc: 'other file' }) };
    const tabs = [submitted, other].map((tab) => tab.path === submitted.path
      ? applyWorkspaceFileSaveResult(tab, submitted, { status: 'written', file: submitted.file })
      : tab);
    expect(tabs[0]?.editorState?.doc.toString()).toBe('submitted');
    expect(tabs[1]).toBe(other);
    expect(canSaveWorkspaceTab(tabs[0], false)).toBe(false);
  });

  it('preserves the draft on revision conflict and blocks saving again', () => {
    const tab = createTab();
    const conflicted = applyWorkspaceFileSaveResult(tab, tab, {
      status: 'conflict', file: { ...tab.file, revision: 'external' },
    });
    expect(conflicted.draftContent).toBe(tab.draftContent);
    expect(conflicted.savedContent).toBe(tab.savedContent);
    expect(conflicted.editorState).toBe(tab.editorState);
    expect(canSaveWorkspaceTab(conflicted, false)).toBe(false);
  });

  it('blocks absent, clean, read-only, and currently saving tabs', () => {
    const tab = createTab();
    expect(canSaveWorkspaceTab(undefined, false)).toBe(false);
    expect(canSaveWorkspaceTab({ ...tab, draftContent: tab.savedContent }, false)).toBe(false);
    expect(canSaveWorkspaceTab({ ...tab, file: { ...tab.file, fileKind: 'too_large' } }, false)).toBe(false);
    expect(canSaveWorkspaceTab(tab, true)).toBe(false);
  });

  it('ignores save completion after the same path is reloaded or reopened', () => {
    const submitted = createTab();
    const reopened = { ...createTab(), loadGeneration: submitted.loadGeneration + 1 };
    for (const status of ['written', 'conflict'] as const) {
      expect(applyWorkspaceFileSaveResult(reopened, submitted, {
        status, file: { ...submitted.file, revision: 'late response' },
      })).toBe(reopened);
    }
  });
});
