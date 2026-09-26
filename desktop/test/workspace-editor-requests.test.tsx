import { CompletionContext } from '@codemirror/autocomplete';
import { createWorkspaceLanguageServerCompletion } from '../frontend/src/features/editor/workspaceLanguageServerCompletion';
import { useWorkspaceEditorNavigation } from '../frontend/src/features/editor/useWorkspaceEditorNavigation';
import { workspaceNavigationKeymap, workspaceTabKeymap } from '../frontend/src/features/editor/workspaceEditorKeymap';
import { expect, test } from 'bun:test';
import { act, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LanguageServerLocation, LanguageServerPrepareRenameResult, LanguageServerReferenceResult,
  LanguageServerRenameResult, WorkspaceFileReadResult, WorkspaceFileVersion, WorkspaceFilesWriteResult,
  LanguageServerStatus, LanguageServerCodeAction, WorkspaceFileExcerptResult, LanguageServerCompletionResult } from '../frontend/src/cheshiDesktop';
import { useWorkspaceAssistRequests, type PendingWorkspaceRename } from '../frontend/src/features/editor/useWorkspaceAssistRequests';
import { useWorkspaceEditorEdits } from '../frontend/src/features/editor/useWorkspaceEditorEdits';
import { beginWorkspaceEditorRequest, createWorkspaceRequestTracker } from '../frontend/src/features/editor/workspaceEditorRequest';
import type { WorkspaceEditorAssistState } from '../frontend/src/features/editor/workspaceEditorAssistState';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
const location: LanguageServerLocation = { path: 'sample.ts', range };
const prepareResult: LanguageServerPrepareRenameResult = { available: true, range, placeholder: 'name' };
const version: WorkspaceFileVersion = { path: 'sample.ts', name: 'sample.ts', kind: 'file', fileKind: 'text',
  size: 4, modifiedAt: 0, revision: 'before', hasBom: false, lineEnding: 'lf' };
const renameResult: LanguageServerRenameResult = {
  failureReason: null, edit: { files: [{ path: 'sample.ts', edits: [{ range, newText: 'next' }] }] },
};
const action: LanguageServerCodeAction = {
  title: 'Rename', kind: 'refactor', preferred: false, disabledReason: null, edit: renameResult.edit,
};

function createModel() {
  // Only the EditorView state boundary is needed by these request hooks.
  const viewState = { state: EditorState.create({ doc: 'name' }) };
  const view = viewState as EditorView;
  const editorViewRef = { current: view as EditorView | null };
  const editorPathRef = { current: 'sample.ts' as string | null };
  const assistStateRef = { current: null as WorkspaceEditorAssistState | null };
  const pendingRenameRef = { current: null as PendingWorkspaceRename | null };
  const assistRequests = createWorkspaceRequestTracker();
  let error = '';
  const setAssistState: Dispatch<SetStateAction<WorkspaceEditorAssistState | null>> = next => {
    assistStateRef.current = typeof next === 'function' ? next(assistStateRef.current) : next;
  };
  const setErrorMessage: Dispatch<SetStateAction<string>> = next => { error = typeof next === 'function' ? next(error) : next; };
  const close = () => { assistRequests.invalidate(); pendingRenameRef.current = null; setAssistState(null); };
  const status: LanguageServerStatus = { language: 'typescript', state: 'running', mode: 'auto',
    serverName: 'TypeScript', displayName: 'TypeScript', message: '', executable: null };
  const tabsRef = { current: [] as WorkspaceTab[] };
  return { view, setEditorState: (state: EditorState) => { viewState.state = state; }, editorViewRef, editorPathRef, assistStateRef, pendingRenameRef, assistRequests, setAssistState,
    setErrorMessage, close, error: () => error, tabsRef, selectedPathRef: editorPathRef,
    referencePreviewRequestSequence: { current: 0 }, languageServersRef: { current: [status] },
    languageServerDiagnosticsRef: { current: new Map() }, workspaceDiagnosticsRef: { current: [] },
    nextLanguageServerDocumentVersion: () => 1, nextTabGeneration: { current: 0 },
    destroyEditor: () => { assistRequests.invalidate(); editorViewRef.current = null; },
    replaceTabs: (update: (tabs: WorkspaceTab[]) => WorkspaceTab[]) => { tabsRef.current = update(tabsRef.current); },
  };
}

async function withHooks<T>(useHook: () => T, run: (read: () => T, unmount: () => Promise<void>) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.createElement('div'));
  let current!: T;
  let mounted = true;
  function Harness() { current = useHook(); return null; }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  try {
    await act(async () => root.render(<Harness />));
    await run(() => current, unmount);
  } finally {
    await unmount();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

type AssistApi = NonNullable<Parameters<typeof useWorkspaceAssistRequests>[0]['api']>;
function assistApi(overrides: Partial<AssistApi> = {}): AssistApi {
  return { getLanguageServerReferences: async () => ({ locations: [] }),
    prepareLanguageServerRename: async () => prepareResult, getLanguageServerCodeActions: async () => ({ actions: [] }),
    readWorkspaceFileExcerpt: async () => { throw new Error('No preview'); }, ...overrides };
}

test('references on the same file keep the latest response and ignore an old failure', async () => {
  for (const fail of [false, true]) {
    const model = createModel();
    const old = createDeferred<LanguageServerReferenceResult>();
    const fresh = createDeferred<LanguageServerReferenceResult>();
    let count = 0;
    const api = assistApi({ getLanguageServerReferences: () => (++count === 1 ? old.promise : fresh.promise) });
    await withHooks(() => useWorkspaceAssistRequests({ ...model, api }), async read => {
      const first = read().requestLanguageServerReferences(model.view, 'sample.ts', 0);
      const second = read().requestLanguageServerReferences(model.view, 'sample.ts', 2);
      fresh.resolve({ locations: [] }); await second;
      const current = model.assistStateRef.current;
      if (fail) old.reject(new Error('Old error')); else old.resolve({ locations: [location] });
      await first;
      expect(model.assistStateRef.current).toBe(current);
      expect(model.error()).toBe('');
    });
  }
});

for (const kind of ['references', 'rename'] as const) {
  for (const invalidate of ['close', 'path', 'editor', 'document', 'unmount'] as const) {
    test(`${kind} ignores a response after ${invalidate}`, async () => {
      const model = createModel();
      const references = createDeferred<LanguageServerReferenceResult>();
      const rename = createDeferred<LanguageServerPrepareRenameResult>();
      const api = assistApi({ getLanguageServerReferences: () => references.promise, prepareLanguageServerRename: () => rename.promise });
      await withHooks(() => useWorkspaceAssistRequests({ ...model, api }), async (read, unmount) => {
        const pending = kind === 'references'
          ? read().requestLanguageServerReferences(model.view, 'sample.ts', 0)
          : read().requestLanguageServerRename(model.view, 'sample.ts', 0);
        if (invalidate === 'close') model.close();
        if (invalidate === 'path') model.editorPathRef.current = 'other.ts';
        if (invalidate === 'editor') model.editorViewRef.current = null;
        if (invalidate === 'document') model.setEditorState(model.view.state.update({ changes: { from: 0, insert: 'x' } }).state);
        if (invalidate === 'unmount') await unmount();
        references.resolve({ locations: [location] }); rename.resolve(prepareResult); await pending;
        expect(model.assistStateRef.current).toBeNull();
        expect(model.pendingRenameRef.current).toBeNull();
        expect(model.error()).toBe('');
      });
    });
  }
}

test('rename, references, and code actions invalidate one another across request types', async () => {
  const model = createModel();
  const oldRename = createDeferred<LanguageServerPrepareRenameResult>();
  const oldReferences = createDeferred<LanguageServerReferenceResult>();
  const api = assistApi({ prepareLanguageServerRename: () => oldRename.promise, getLanguageServerReferences: () => oldReferences.promise });
  await withHooks(() => useWorkspaceAssistRequests({ ...model, api }), async read => {
    const rename = read().requestLanguageServerRename(model.view, 'sample.ts', 0);
    const references = read().requestLanguageServerReferences(model.view, 'sample.ts', 0);
    await read().requestLanguageServerCodeActions(model.view, 'sample.ts');
    const current = model.assistStateRef.current;
    oldReferences.resolve({ locations: [location] }); oldRename.resolve(prepareResult);
    await Promise.all([rename, references]);
    expect(model.assistStateRef.current).toBe(current);
    expect(current?.kind).toBe('actions');
    expect(model.pendingRenameRef.current).toBeNull();
  });
});

type EditsApi = NonNullable<Parameters<typeof useWorkspaceEditorEdits>[0]['api']>;
function editsApi(overrides: Partial<EditsApi> = {}): EditsApi {
  return { readWorkspaceFile: async () => ({ file: version, content: 'name', dataUrl: null }),
    renameLanguageServerSymbol: async () => renameResult,
    writeWorkspaceFiles: async () => ({ status: 'written', files: [{ ...version, revision: 'after' }] }), ...overrides };
}
function startRename(model: ReturnType<typeof createModel>) {
  const request = beginWorkspaceEditorRequest(model.assistRequests, model.view, 'sample.ts', model.editorViewRef, model.editorPathRef);
  model.pendingRenameRef.current = { path: 'sample.ts', position: range.start, request };
  model.setAssistState({ kind: 'rename', value: 'next', placeholder: 'name', submitting: false });
}

for (const stage of ['rename', 'preview'] as const) {
  for (const fail of [false, true]) {
    test(`closing during ${stage} ignores its late ${fail ? 'failure' : 'success'}`, async () => {
      const model = createModel(); startRename(model);
      const rename = createDeferred<LanguageServerRenameResult>();
      const preview = createDeferred<WorkspaceFileReadResult>();
      let reads = 0;
      const api = editsApi({ renameLanguageServerSymbol: () => rename.promise,
        readWorkspaceFile: () => { reads++; return preview.promise; } });
      await withHooks(() => useWorkspaceEditorEdits({ ...model, api }), async read => {
        const pending = read().submitRename();
        if (stage === 'preview') { rename.resolve(renameResult); await Promise.resolve(); expect(reads).toBe(1); }
        model.close();
        if (stage === 'rename') {
          if (fail) rename.reject(new Error('Late rename')); else rename.resolve(renameResult);
        } else {
          if (fail) preview.reject(new Error('Late preview')); else preview.resolve({ file: version, content: 'name', dataUrl: null });
        }
        await pending;
        expect(model.assistStateRef.current).toBeNull();
        expect(model.error()).toBe('');
        if (stage === 'rename') expect(reads).toBe(0);
      });
    });
  }
}

test('consecutive code action previews keep the newer selection', async () => {
  const model = createModel(); startRename(model);
  const first = createDeferred<WorkspaceFileReadResult>();
  const second = createDeferred<WorkspaceFileReadResult>();
  let reads = 0;
  const api = editsApi({ readWorkspaceFile: () => (++reads === 1 ? first.promise : second.promise) });
  await withHooks(() => useWorkspaceEditorEdits({ ...model, api }), async read => {
    read().chooseCodeAction({ ...action, title: 'First' });
    read().chooseCodeAction({ ...action, title: 'Second' });
    second.resolve({ file: version, content: 'name', dataUrl: null }); await second.promise; await Promise.resolve();
    first.resolve({ file: version, content: 'name', dataUrl: null }); await first.promise; await Promise.resolve();
    const current = model.assistStateRef.current;
    expect(current?.kind === 'edit-preview' && current.title).toBe('Second');
  });
});

test('rename submission and apply are each dispatched once and reconcile successful writes after close', async () => {
  const model = createModel(); startRename(model);
  let renames = 0;
  let writes = 0;
  const write = createDeferred<WorkspaceFilesWriteResult>();
  model.tabsRef.current = [{ path: 'sample.ts', file: version, savedContent: 'name', draftContent: 'name',
    conflictMessage: null, loadGeneration: 1, sourceExcerpt: null, previewDataUrl: null }];
  const api = editsApi({ renameLanguageServerSymbol: async () => { renames++; return renameResult; },
    writeWorkspaceFiles: () => { writes++; return write.promise; } });
  await withHooks(() => useWorkspaceEditorEdits({ ...model, api }), async read => {
    await Promise.all([read().submitRename(), read().submitRename()]);
    expect(renames).toBe(1);
    expect(model.assistStateRef.current?.kind).toBe('edit-preview');
    const applying = read().applyPreparedWorkspaceEdit();
    await read().applyPreparedWorkspaceEdit(); expect(writes).toBe(1);
    model.close();
    model.tabsRef.current[0] = { ...model.tabsRef.current[0]!, draftContent: 'typed during save' };
    write.resolve({ status: 'written', files: [{ ...version, revision: 'after' }] }); await applying;
    expect(model.tabsRef.current[0]?.savedContent).toBe('next');
    expect(model.tabsRef.current[0]?.draftContent).toBe('typed during save');
    expect(model.assistStateRef.current).toBeNull();
  });
});

test('navigation preserves back/forward positions, rewrites moved paths and removes deleted paths', async () => {
  const model = createModel();
  const loaded: [string, number | null | undefined, number | null | undefined][] = [];
  const loadFileRef = { current: async (path: string, line?: number | null, _reload?: boolean, character?: number | null) => {
    loaded.push([path, line, character]);
    model.editorPathRef.current = path;
    model.setEditorState(EditorState.create({ doc: 'name', selection: { anchor: character ?? 0 } }));
  } };
  await withHooks(() => useWorkspaceEditorNavigation({ ...model, loadFileRef }), async read => {
    await act(async () => {
      read().recordNavigationOrigin();
      read().recordNavigationOrigin(); // duplicate origins must not consume extra history entries
      model.editorPathRef.current = 'other.ts';
      model.setEditorState(model.view.state.update({ selection: { anchor: 2 } }).state);
      await read().navigateHistory('back');
    });
    expect(loaded).toEqual([['sample.ts', 1, 0]]);
    expect(read().navigationAvailability).toEqual({ back: false, forward: true });
    await act(async () => read().navigateHistory('forward'));
    expect(loaded.at(-1)).toEqual(['other.ts', 1, 2]);
    await act(async () => {
      read().renameNavigationPath('sample.ts', 'moved/sample.ts');
      await read().navigateHistory('back');
    });
    expect(loaded.at(-1)).toEqual(['moved/sample.ts', 1, 0]);
    await act(async () => read().removeNavigationPath('other.ts'));
    expect(read().navigationAvailability.forward).toBe(false);
    await act(async () => read().navigateHistory('forward'));
    expect(loaded).toHaveLength(3);
  });
});

test('recording a new navigation origin clears forward history', async () => {
  const model = createModel();
  const loadFileRef = { current: async (path: string) => { model.editorPathRef.current = path; } };
  await withHooks(() => useWorkspaceEditorNavigation({ ...model, loadFileRef }), async read => {
    await act(async () => {
      read().recordNavigationOrigin();
      model.editorPathRef.current = 'next.ts';
      await read().navigateHistory('back');
    });
    expect(read().navigationAvailability.forward).toBe(true);
    await act(async () => read().recordNavigationOrigin());
    expect(read().navigationAvailability.forward).toBe(false);
  });
});

test('shared keymaps use the latest tabs and close handler in either editor mode', async () => {
  const model = createModel();
  const selected: string[] = [];
  const closed: string[] = [];
  const tabsRef = { current: [{ path: 'old.ts' }] };
  const closeRef = { current: (_path: string | null) => {} };
  const bindings = workspaceTabKeymap('sample.ts', closeRef, tabsRef, path => selected.push(path));
  tabsRef.current = [{ path: 'new.ts' }];
  closeRef.current = path => { if (path) closed.push(path); };
  expect(bindings.find(binding => binding.key === 'Mod-1')?.run?.(model.view)).toBe(true);
  expect(bindings.find(binding => binding.key === 'Mod-9')?.run?.(model.view)).toBe(true);
  expect(bindings.find(binding => binding.key === 'Mod-w')?.run?.(model.view)).toBe(true);
  expect(selected).toEqual(['new.ts']); expect(closed).toEqual(['sample.ts']);
  const navigation: string[] = [];
  const history = workspaceNavigationKeymap(async direction => { navigation.push(direction); });
  for (const binding of history) expect(binding.run?.(model.view)).toBe(true);
  expect(navigation).toEqual(['back', 'forward', 'back', 'forward']);
});

test('same-file rename preparation keeps the latest symbol and position', async () => {
  const model = createModel();
  const old = createDeferred<LanguageServerPrepareRenameResult>();
  let requests = 0;
  const api = assistApi({ prepareLanguageServerRename: () => ++requests === 1 ? old.promise : Promise.resolve({ ...prepareResult, placeholder: 'latest' }) });
  await withHooks(() => useWorkspaceAssistRequests({ ...model, api }), async read => {
    const pending = read().requestLanguageServerRename(model.view, 'sample.ts', 0);
    await read().requestLanguageServerRename(model.view, 'sample.ts', 2);
    old.resolve(prepareResult); await pending;
    const current = model.assistStateRef.current;
    expect(current?.kind === 'rename' && current.placeholder).toBe('latest');
    expect(model.pendingRenameRef.current?.position.character).toBe(2);
  });
});

test('a reference preview cannot populate a later list with the same selected index', async () => {
  const model = createModel();
  const old = createDeferred<WorkspaceFileExcerptResult>();
  const fresh = createDeferred<WorkspaceFileExcerptResult>();
  let previews = 0;
  const api = assistApi({ getLanguageServerReferences: async () => ({ locations: [location] }),
    readWorkspaceFileExcerpt: () => ++previews === 1 ? old.promise : fresh.promise });
  const excerpt = (content: string): WorkspaceFileExcerptResult => ({ file: version, content,
    startLine: 1, endLine: 1, targetLine: 1, hasMoreBefore: false, hasMoreAfter: false });
  await withHooks(() => useWorkspaceAssistRequests({ ...model, api }), async read => {
    await read().requestLanguageServerReferences(model.view, 'sample.ts', 0);
    await read().requestLanguageServerReferences(model.view, 'sample.ts', 2);
    fresh.resolve(excerpt('new preview')); await fresh.promise;
    old.resolve(excerpt('old preview')); await old.promise;
    const current = model.assistStateRef.current;
    expect(current?.kind === 'references' && current.preview?.content).toBe('new preview');
  });
});

test('closing then reopening rename prevents a previous submission from replacing the new form', async () => {
  const model = createModel(); startRename(model);
  const old = createDeferred<LanguageServerRenameResult>();
  const api = editsApi({ renameLanguageServerSymbol: () => old.promise });
  await withHooks(() => useWorkspaceEditorEdits({ ...model, api }), async read => {
    const pending = read().submitRename();
    model.close(); startRename(model); read().changeRenameValue('latest');
    const current = model.assistStateRef.current;
    old.resolve(renameResult); await pending;
    expect(model.assistStateRef.current).toBe(current);
    expect(current?.kind === 'rename' && current.value).toBe('latest');
  });
});

test('a current rename error restores the form for retry; a write conflict keeps the preview', async () => {
  const model = createModel(); startRename(model);
  let attempt = 0;
  const api = editsApi({ renameLanguageServerSymbol: async () => {
    if (++attempt === 1) throw new Error('Rename unavailable');
    return renameResult;
  }, writeWorkspaceFiles: async () => ({ status: 'conflict', files: [] }) });
  await withHooks(() => useWorkspaceEditorEdits({ ...model, api }), async read => {
    await read().submitRename();
    const form = model.assistStateRef.current;
    expect(form?.kind === 'rename' && form.submitting).toBe(false);
    expect(model.error()).toBe('Rename unavailable');
    await read().submitRename();
    expect(model.assistStateRef.current?.kind).toBe('edit-preview');
    await read().applyPreparedWorkspaceEdit();
    const preview = model.assistStateRef.current;
    expect(preview?.kind === 'edit-preview' && preview.applying).toBe(false);
    expect(model.error()).not.toBe('');
  });
});

for (const change of ['none', 'path', 'document', 'editor'] as const) {
  test(`completion checks editor ownership after ${change} changes`, async () => {
    const model = createModel();
    const deferred = createDeferred<LanguageServerCompletionResult>();
    const source = createWorkspaceLanguageServerCompletion({ ...model,
      api: { getLanguageServerCompletions: () => deferred.promise } })('sample.ts');
    const pending = source(new CompletionContext(model.view.state, 4, true, model.view));
    if (change === 'path') model.editorPathRef.current = 'other.ts';
    if (change === 'editor') model.editorViewRef.current = null;
    if (change === 'document') model.setEditorState(model.view.state.update({ changes: { from: 0, insert: 'x' } }).state);
    deferred.resolve({ isIncomplete: false, items: [] });
    const result = await pending;
    if (change === 'none') expect(result).toEqual({ from: 0, to: 4, options: [], validFor: /^[\w$]*$/ });
    else expect(result).toBeNull();
  });
}
