import { describe, expect, it } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  canApplyWorkspaceFileLoad,
  createWorkspaceFileLoadTracker,
  normalizeWorkspaceEditorContent,
} from '../frontend/src/features/editor/workspaceFileLoad';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';
import { applyWorkspaceFileSaveResult, canSaveWorkspaceTab } from '../frontend/src/features/editor/workspaceFileSave';
import { readWorkspaceFile } from '../lib/workspace-file-reads.mts';
import { writeWorkspaceFile } from '../lib/workspace-file-writes.mts';

function createTab(): WorkspaceTab {
  return {
    path: 'a.ts',
    file: {
      path: 'a.ts', name: 'a.ts', kind: 'file', fileKind: 'text', size: 0,
      modifiedAt: 0, revision: 'initial', hasBom: false, lineEnding: 'lf',
    },
    previewDataUrl: null, sourceExcerpt: null,
    savedContent: 'initial', draftContent: 'initial',
    conflictMessage: null, loadGeneration: 1,
  };
}

describe('workspace file load ownership', () => {
  it('rejects pending reads after another navigation or tab close invalidates them', async () => {
    const tracker = createWorkspaceFileLoadTracker();
    const request = tracker.begin();
    const result = Promise.resolve().then(() => tracker.isCurrent(request));
    tracker.invalidate();
    expect(await result).toBe(false);
    const nextRequest = tracker.begin();
    expect(tracker.isCurrent(nextRequest)).toBe(true);
    expect(tracker.isCurrent(request)).toBe(false);
  });

  it('accepts only the most recent read when responses arrive out of order', () => {
    const tracker = createWorkspaceFileLoadTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(tracker.isCurrent(second)).toBe(true);
    expect(tracker.isCurrent(first)).toBe(false);
  });

  it('preserves edits made while an automatic reload is reading disk', () => {
    const started = createTab();
    expect(canApplyWorkspaceFileLoad(started, { ...started, draftContent: 'new typing' })).toBe(false);
    expect(canApplyWorkspaceFileLoad(started, started)).toBe(true);
  });

  it('allows explicitly reloading an unchanged dirty snapshot', () => {
    const started = { ...createTab(), draftContent: 'discarded by explicit reload' };
    expect(canApplyWorkspaceFileLoad(started, started)).toBe(true);
    expect(canApplyWorkspaceFileLoad(started, { ...started, draftContent: 'more typing' })).toBe(false);
  });

  it('rejects a closed, reopened, or newly saved tab but permits a fresh first open', () => {
    const started = createTab();
    expect(canApplyWorkspaceFileLoad(started, undefined)).toBe(false);
    expect(canApplyWorkspaceFileLoad(started, { ...started, loadGeneration: 2 })).toBe(false);
    expect(canApplyWorkspaceFileLoad(started, { ...started, file: { ...started.file, revision: 'saved' } })).toBe(false);
    expect(canApplyWorkspaceFileLoad(undefined, started)).toBe(false);
    expect(canApplyWorkspaceFileLoad(undefined, undefined)).toBe(true);
  });
});

describe('workspace editor line endings', () => {
  for (const [name, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
    it(`keeps unedited ${name} files clean when editor state is captured`, () => {
      const content = normalizeWorkspaceEditorContent(`first${lineEnding}second${lineEnding}`);
      const tab = { ...createTab(), savedContent: content, draftContent: content };
      const state = EditorState.create({ doc: tab.draftContent });
      const captured = { ...tab, draftContent: state.doc.toString(), editorState: state };
      expect(canSaveWorkspaceTab(captured, false)).toBe(false);

      const changed = state.update({ changes: { from: 0, to: 5, insert: 'edited' } }).state;
      const edited = { ...captured, draftContent: changed.doc.toString(), editorState: changed };
      expect(canSaveWorkspaceTab(edited, false)).toBe(true);
    });

    it(`preserves ${name} and a BOM on disk after an actual edit and save`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cheshi-editor-line-ending-'));
      try {
        const filePath = path.join(directory, 'a.ts');
        await writeFile(filePath, `\uFEFFfirst${lineEnding}second${lineEnding}`);
        const response = await readWorkspaceFile(directory, 'a.ts');
        expect(response.file.hasBom).toBe(true);
        const content = normalizeWorkspaceEditorContent(response.content ?? '');
        const tab = {
          ...createTab(), file: response.file, savedContent: content, draftContent: content,
        };
        const state = EditorState.create({ doc: content });
        const changed = state.update({ changes: { from: 0, to: 5, insert: 'edited' } }).state;
        const edited = { ...tab, draftContent: changed.doc.toString(), editorState: changed };
        const saved = await writeWorkspaceFile(directory, {
          path: edited.path,
          content: edited.draftContent,
          expectedRevision: edited.file.revision,
          hasBom: edited.file.hasBom,
          lineEnding: edited.file.lineEnding,
        });
        expect(saved.status).toBe('written');
        expect(await readFile(filePath, 'utf8')).toBe(`\uFEFFedited${lineEnding}second${lineEnding}`);
        expect(canSaveWorkspaceTab(applyWorkspaceFileSaveResult(edited, edited, saved), false)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
