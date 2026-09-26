import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import { dispatchSharedEditorTransactions, nextEditorDocumentVersion,
  sharedEditorDocument } from '../frontend/src/features/editor/editorSharedDocuments';

async function withEditors(run: (create: (path: string, state?: EditorState) => EditorView) => void) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const views: EditorView[] = [];
  try {
    run((path, state) => {
      const extensions = [history(), sharedEditorDocument(path)];
      const view = new EditorView({ parent: document.body,
        state: state ? state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
          : EditorState.create({ doc: 'hello', extensions }),
        dispatchTransactions: (transactions, current) => dispatchSharedEditorTransactions(path, transactions, current) });
      views.push(view);
      return view;
    });
  } finally {
    for (const view of views) view.destroy();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('editing and undo/redo update every view of a file, with independent selections', async () => {
  await withEditors(create => {
    const left = create('a.ts'), right = create('a.ts'), unrelated = create('b.ts');
    right.dispatch({ selection: { anchor: 4 } });
    left.dispatch({ changes: { from: 5, insert: '!' }, selection: { anchor: 6 } });
    expect(right.state.doc.toString()).toBe('hello!');
    expect(right.state.selection.main.head).toBe(4);
    expect(unrelated.state.doc.toString()).toBe('hello');
    expect(undo(left)).toBe(true);
    expect(right.state.doc.toString()).toBe('hello');
    expect(redo(left)).toBe(true);
    expect(right.state.doc.toString()).toBe('hello!');
    left.destroy();
    right.dispatch({ changes: { from: 0, insert: 'a' } });
    expect(right.state.doc.toString()).toBe('ahello!');
  });
});

test('moving a document reconfigures pane callbacks while retaining undo and cursor', async () => {
  await withEditors(create => {
    const source = create('move.ts');
    source.dispatch({ changes: { from: 5, insert: ' moved' }, selection: { anchor: 8 } });
    const state = source.state;
    source.destroy();
    const destination = create('move.ts', state);
    expect(destination.state.selection.main.head).toBe(8);
    expect(undo(destination)).toBe(true);
    expect(destination.state.doc.toString()).toBe('hello');
  });
});

test('language server document versions increase across panes and reopenings', () => {
  const version = nextEditorDocumentVersion('version.ts');
  nextEditorDocumentVersion('different.ts');
  expect(nextEditorDocumentVersion('version.ts')).toBe(version + 1);
  expect(nextEditorDocumentVersion('version.ts')).toBe(version + 2);
});
