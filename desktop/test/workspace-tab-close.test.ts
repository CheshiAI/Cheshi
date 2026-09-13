import { describe, expect, it } from 'bun:test';

import { confirmWorkspaceTabsClose } from '../frontend/src/features/editor/workspaceTabClose';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';

const isDirty = (tab: WorkspaceTab): boolean => tab.draftContent !== tab.savedContent;

function createTab(path: string, dirty = false): WorkspaceTab {
  return {
    path,
    file: {
      path,
      name: path,
      kind: 'file',
      fileKind: 'text',
      size: 0,
      modifiedAt: 0,
      revision: 'initial',
      hasBom: false,
      lineEnding: 'lf',
    },
    savedContent: 'saved',
    draftContent: dirty ? 'modified' : 'saved',
    previewDataUrl: null,
    sourceExcerpt: null,
    conflictMessage: null,
    loadGeneration: 0,
  };
}

describe('workspace tab close confirmation', () => {
  it('closes clean tabs without asking to discard changes', () => {
    const prompted: string[] = [];
    expect(confirmWorkspaceTabsClose([createTab('clean.ts')], isDirty, (path) => {
      prompted.push(path);
      return false;
    })).toBe(true);
    expect(prompted).toEqual([]);
  });

  it('requires approval for every dirty tab while skipping clean tabs', () => {
    const prompted: string[] = [];
    const tabs = [createTab('first.ts', true), createTab('clean.ts'), createTab('last.ts', true)];
    expect(confirmWorkspaceTabsClose(tabs, isDirty, (path) => {
      prompted.push(path);
      return true;
    })).toBe(true);
    expect(prompted).toEqual(['first.ts', 'last.ts']);
  });

  it('cancels the entire close request without mutating drafts when a later confirmation is declined', () => {
    const tabs = [createTab('first.ts', true), createTab('second.ts', true), createTab('third.ts', true)];
    const original = structuredClone(tabs);
    const prompted: string[] = [];
    expect(confirmWorkspaceTabsClose(tabs, isDirty, (path) => {
      prompted.push(path);
      return path === 'first.ts';
    })).toBe(false);
    expect(prompted).toEqual(['first.ts', 'second.ts']);
    expect(tabs).toEqual(original);
  });
});
