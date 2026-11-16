import { expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { createEditorPaneStore, updateEditorStateDocument } from '../frontend/src/features/editor/editorPaneStore';
import { parseEditorPaneSession } from '../frontend/src/features/editor/editorPaneLayout';
import { droppedWorkspacePaths, readEditorTabTransfer, EDITOR_TAB_TRANSFER_TYPE } from '../frontend/src/features/editor/editorFileDrop';
import { splitPaneIds } from '../frontend/src/shared/ui/splitPaneModel';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';
import { applyWorkspaceFileSaveResult } from '../frontend/src/features/editor/workspaceFileSave';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';

function tab(path: string): WorkspaceTab {
  let state = EditorState.create({ doc: 'saved', extensions: [history()] });
  state = state.update({ changes: { from: 5, insert: ' draft' }, selection: { anchor: 8 } }).state;
  return { path, file: { path, name: path, kind: 'file', fileKind: 'text', size: 5, modifiedAt: 1,
    revision: 'r', hasBom: false, lineEnding: 'lf' }, savedContent: 'saved', draftContent: 'saved draft',
    conflictMessage: null, previewDataUrl: null, sourceExcerpt: null, loadGeneration: 1, editorState: state };
}

test('moves dirty tabs to all four split edges preserving selection and undo; collapses empty source', () => {
  for (const direction of ['left', 'right', 'up', 'down'] as const) {
    const store = createEditorPaneStore();
    const a = tab('a.ts'), b = tab('b.ts');
    store.restore([a, b]);
    const destination = store.place(a, 'editor-main', direction, 'editor-main')!;
    const state = store.getSnapshot();
    expect(splitPaneIds(state.layout)).toEqual(direction === 'left' || direction === 'up'
      ? [destination, 'editor-main'] : ['editor-main', destination]);
    expect(state.groups['editor-main']!.tabs.map(t => t.path)).toEqual(['b.ts']);
    const moved = state.groups[destination]!.tabs[0]!;
    expect(moved.editorState).toBe(a.editorState);
    expect(moved.editorState!.selection.main.head).toBe(8);
    let undone = '';
    expect(undo({ state: moved.editorState!, dispatch: tr => { undone = tr.state.doc.toString(); } })).toBe(true);
    expect(undone).toBe('saved');
    store.place(b, destination, null, 'editor-main');
    expect(splitPaneIds(store.getSnapshot().layout)).toEqual([destination]);
    expect(store.allTabs().map(t => t.path).sort()).toEqual(['a.ts', 'b.ts']);
  }
});

test('splitting a sole tab creates a second view and shares edits, revisions and conflict state', () => {
  const store = createEditorPaneStore();
  const a = tab('a.ts');
  store.restore([a]);
  const other = store.place(a, 'editor-main', 'right', 'editor-main')!;
  expect(store.sharedElsewhere('editor-main', a.path)).toBe(true);
  store.replace(other, tabs => tabs.map(t => ({ ...t, draftContent: 'saved changed', conflictMessage: 'conflict' })));
  const peer = store.getSnapshot().groups['editor-main']!.tabs[0]!;
  expect(peer.draftContent).toBe('saved changed');
  expect(peer.editorState!.doc.toString()).toBe('saved changed');
  expect(peer.conflictMessage).toBe('conflict');
  store.replace(other, tabs => tabs.map(t => ({ ...t, savedContent: t.draftContent, conflictMessage: null,
    file: { ...t.file, revision: 'saved-revision' } })));
  expect(store.getSnapshot().groups['editor-main']!.tabs[0]!.file.revision).toBe('saved-revision');
  expect(store.allTabs()).toHaveLength(1);
  store.replace(other, () => []);
  store.closeEmpty(other);
  expect(splitPaneIds(store.getSnapshot().layout)).toEqual(['editor-main']);
  expect(store.allTabs()).toHaveLength(1);
});

test('restores pane order, selection and layout, pruning missing files while retaining new restored drafts', () => {
  const store = createEditorPaneStore();
  const a = tab('a.ts'), b = tab('b.ts'), c = tab('c.ts');
  store.restore([a, b]);
  const other = store.place(b, 'editor-main', 'down', 'editor-main')!;
  store.configure(other, { problemsOpen: false, problemsRatio: .4 });
  const snapshot = JSON.parse(JSON.stringify(store.snapshot()));
  const restored = createEditorPaneStore();
  restored.restore([a, b, c], snapshot);
  expect(restored.getSnapshot().activeId).toBe(other);
  expect(restored.getSnapshot().groups[other]!.selectedPath).toBe('b.ts');
  expect(restored.getSnapshot().groups[other]!.problemsOpen).toBe(false);
  expect(restored.getSnapshot().groups[other]!.problemsRatio).toBe(.4);
  expect(restored.getSnapshot().groups[other]!.tabs.map(t => t.path)).toEqual(['b.ts', 'c.ts']);
  restored.restore([a], snapshot);
  expect(splitPaneIds(restored.getSnapshot().layout)).toEqual(['editor-main']);
  expect(restored.getSnapshot().groups['editor-main']!.tabs[0]!.draftContent).toBe(a.draftContent);
});

test('invalid layouts, duplicate panes and malformed or outside-workspace drag data are rejected', () => {
  expect(parseEditorPaneSession({ layout: { type: 'pane', paneId: '__proto__' } })).toBeNull();
  const store = createEditorPaneStore();
  const snapshot = store.snapshot();
  expect(parseEditorPaneSession({ ...snapshot, layout: { type: 'split', id: 's', axis: 'rows', ratio: .5,
    first: snapshot.layout, second: snapshot.layout } })).toBeNull();
  const data = { types: [WORKSPACE_FILE_TRANSFER_TYPE], getData: () => JSON.stringify([
    '/work/a.ts', '/workspace/b.ts', '/work/../other/a.ts', '/work/a.ts', '/work/folder/c.ts', '/work//bad',
  ]) };
  expect(droppedWorkspacePaths(data, '/work')).toEqual(['a.ts', 'folder/c.ts']);
  expect(readEditorTabTransfer({ getData: () => '{' })).toBeNull();
  expect(readEditorTabTransfer({ getData: type => type === EDITOR_TAB_TRANSFER_TYPE
    ? JSON.stringify({ paneId: 'editor-main', path: 'a.ts' }) : '' })).toEqual({ paneId: 'editor-main', path: 'a.ts' });
});

test('stale source drops do nothing and capture obtains the latest cursor before a transfer', () => {
  const store = createEditorPaneStore();
  store.restore([tab('a.ts'), tab('b.ts')]);
  let captured = false;
  store.registerCapture('editor-main', () => { captured = true; });
  expect(store.place(tab('missing'), 'editor-main', 'right', 'editor-main')).toBeNull();
  expect(captured).toBe(false);
  store.place(tab('a.ts'), 'editor-main', 'right', 'editor-main');
  expect(captured).toBe(true);
});

test('saving while another pane edits keeps the later draft and shares the saved revision', () => {
  const store = createEditorPaneStore();
  const a = tab('a.ts');
  store.restore([a]);
  const other = store.place(a, 'editor-main', 'right', 'editor-main')!;
  store.replace(other, tabs => tabs.map(t => ({ ...t, draftContent: `${t.draftContent}!` })));
  store.replace('editor-main', tabs => tabs.map(t => applyWorkspaceFileSaveResult(t, a,
    { status: 'written', file: { ...a.file, revision: 'new' } })));
  const peer = store.getSnapshot().groups[other]!.tabs[0]!;
  expect(peer.savedContent).toBe(a.draftContent);
  expect(peer.draftContent).toBe(`${a.draftContent}!`);
  expect(peer.file.revision).toBe('new');
});

test('document edits map cursor positions in inactive views without replacing their history', () => {
  const original = tab('a.ts').editorState!;
  expect(updateEditorStateDocument(original, original.doc.toString())).toBe(original);
  const next = updateEditorStateDocument(original, `x${original.doc}`)!;
  expect(next.selection.main.head).toBe(9);
  let undone = '';
  undo({ state: next, dispatch: tr => { undone = tr.state.doc.toString(); } });
  expect(undone).toBe('xsaved');
});
