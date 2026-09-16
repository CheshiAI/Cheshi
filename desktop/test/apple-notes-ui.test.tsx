import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as contract from '../shared/apple-notes';
import type { AppleNotesBrowserState } from '../frontend/src/features/notes/appleNotesModel';
import type { AppleNotesDeleteDialog } from '../frontend/src/features/notes/AppleNotesDeleteDialog';
import type { AppleNotesSaveDialog } from '../frontend/src/features/notes/AppleNotesSaveDialog';
import type { AppleNotesBrowser } from '../frontend/src/features/notes/AppleNotesBrowser';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const note: contract.AppleNote = { id: 'note', title: '<script>title</script>', plaintext: '<img src=x onerror=alert(1)>',
  modifiedAt: '2026-09-16T00:00:00Z', locked: false };
function state(): AppleNotesBrowserState {
  return { folders: [{ id: 'folder', name: 'Notes', account: 'iCloud', path: 'Notes', isDefault: true }],
    folderId: 'folder', notes: [note], selectedId: note.id, note, nextOffset: null,
    loadingFolders: false, loadingNotes: false, refreshingNotes: false, loadingNote: false, error: null };
}
function api(create: contract.AppleNotesApi['create']): contract.AppleNotesApi {
  return { available: true, folders: async () => [], list: async () => ({ notes: [], nextOffset: null }), read: async () => note, document: async () => ({ ...note, html: '<p>Text</p>', attachmentCount: 0 }), update: async () => ({ ok: false, error: { code: 'unavailable', message: 'Unavailable' } }), delete: async id => ({ ok: true, value: { id } }), create };
}

function harness<T>(file: string, symbol: string, browserState = state()) {
  const selectedFolders: string[] = [];
  const reloadedFolders: string[] = [];
  const selectedNotes: string[] = [];
  const removedNotes: { folderId: string; noteId: string }[] = [];
  const refreshes: boolean[] = [];
  const slots: unknown[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  const modules: Record<string, unknown> = {
    react: {
      useRef(current: unknown) { return slots[cursor++] ??= { current }; },
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useId() { return 'test-id'; },
      useEffect(effect: () => () => void) {
        const index = cursor++;
        if (!(index in slots)) { slots[index] = true; effects.push(effect()); }
      },
    },
    'react/jsx-runtime': jsx,
    'lucide-react': { Trash2: 'trash-icon', Paperclip: 'paperclip-icon', Plus: 'plus-icon', Check: 'check-icon', StickyNote: 'note-icon', RefreshCw: 'refresh-icon', LockKeyhole: 'lock-icon',
      Search: 'search-icon', ChevronRight: 'chevron-icon', Folder: 'folder-icon', FolderOpen: 'open-folder-icon' },
    '../../../../shared/apple-notes': contract,
    '../../cheshiDesktop': { cheshiDesktop: undefined },
    '../../shared/ui': { LiquidGlassPanel: 'section', Modal: 'modal', NeumorphicButton: 'button', NeumorphicTextField: 'input', Tooltip: 'tooltip', SearchClearButton: 'clear-button' },
    './AppleNotesEditor': { AppleNotesEditor: 'note-editor' },
    './AppleNotesDeleteDialog': { AppleNotesDeleteDialog: 'delete-dialog' },
    './AppleNotesSaveDialog': { AppleNotesSaveDialog: 'save-dialog' },
    './AppleNotesFolderField': { AppleNotesFolderField: 'folder-field' },
    './AppleNotes.module.css': { default: {} },
    './useAppleNotesBrowser': { useAppleNotesBrowser: () => ({ state: browserState, browser: {
      applyUpdated: () => {},
      removeDeleted: (folderId: string, noteId: string) => { removedNotes.push({ folderId, noteId }); },
      refresh: async (forceRefresh = true) => { refreshes.push(forceRefresh); },
      selectFolder: async (id: string, options?: { forceRefresh?: boolean }) => {
        selectedFolders.push(id);
        if (options?.forceRefresh === true) reloadedFolders.push(id);
      }, loadMore: async () => {},
      selectNote: async (id: string) => { selectedNotes.push(id); },
    } }) },
  };
  const source = readFileSync(new URL(`../frontend/src/features/notes/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, require(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  } });
  return {
    selectedFolders,
    reloadedFolders,
    selectedNotes,
    removedNotes,
    refreshes,
    render(run: (component: T) => ReactNode) { cursor = 0; return run(exports[symbol] as T); },
    unmount() { effects.forEach(cleanup => cleanup()); },
  };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    return [child, ...elements(child.props.children as ReactNode)];
  });
}
function find(node: ReactNode, predicate: (element: ReactElement<Record<string, unknown>>) => boolean) {
  const element = elements(node).find(predicate);
  if (!element) throw new Error('Expected UI element was not rendered.');
  return element;
}
function submit(node: ReactNode) {
  const form = find(node, element => element.type === 'form');
  if (typeof form.props.onSubmit !== 'function') throw new Error('Missing submit handler.');
  form.props.onSubmit({ preventDefault() {} });
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function change(node: ReactNode, predicate: (element: ReactElement<Record<string, unknown>>) => boolean, value: string) {
  const field = find(node, predicate);
  if (typeof field.props.onChange !== 'function') throw new Error('Missing change handler.');
  field.props.onChange(field.type === 'folder-field' ? value : { target: { value } });
}

function click(node: ReactNode, predicate: (element: ReactElement<Record<string, unknown>>) => boolean) {
  const button = find(node, predicate);
  if (typeof button.props.onClick !== 'function') throw new Error('Missing click handler.');
  button.props.onClick();
}

const titleField = (element: ReactElement<Record<string, unknown>>) => element.type === 'input' && element.props.maxLength === contract.APPLE_NOTES_MAX_TITLE_LENGTH;
const bodyField = (element: ReactElement<Record<string, unknown>>) => element.type === 'input' && element.props.multiline === true;
const folderField = (element: ReactElement<Record<string, unknown>>) => element.type === 'folder-field';

test('background revalidation keeps cached rows and empty-folder messages visible without a loading placeholder', () => {
  const browserState = state();
  browserState.refreshingNotes = true;
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser', browserState);
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })), onAttach: async () => true }));
  expect(find(render(), element => element.props.title === note.title).type).toBe('button');
  expect(elements(render()).some(element => element.props.children === 'Loading notes…')).toBe(false);
  browserState.notes = [];
  expect(find(render(), element => element.props.children === 'This folder has no notes.')).toBeDefined();
  expect(elements(render()).some(element => element.props.children === 'Loading notes…')).toBe(false);
});

test('note actions are provided to the editor header and are disabled without a selected note', () => {
  const browserState = state();
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser', browserState);
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })), onAttach: async () => true }));
  const tree = render();
  const editor = find(tree, element => element.type === 'note-editor');
  expect(find(editor.props.children as ReactNode, element => element.props['aria-label'] === 'Delete note').props.disabled).toBe(false);
  expect(find(editor.props.children as ReactNode, element => element.props['aria-label'] === 'Attach to conversation').props.disabled).toBe(false);
  expect(elements(find(tree, element => element.type === 'footer')).some(element => element.type === 'button')).toBe(false);
  browserState.note = null;
  expect(find(render(), element => element.props['aria-label'] === 'Delete note').props.disabled).toBe(true);
  expect(find(render(), element => element.props['aria-label'] === 'Attach to conversation').props.disabled).toBe(true);
});

test('unsaved editor changes disable folder navigation, refresh, deletion and attachment', () => {
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })),
    onAttach: async () => true, renderHeader: (refresh, create, search) => <header>{search}{refresh}{create}</header> }));
  const editor = find(render(), element => element.type === 'note-editor');
  if (typeof editor.props.onBusyChange !== 'function') throw new Error('Missing editor state callback');
  editor.props.onBusyChange(true);
  const tree = render();
  expect(find(tree, element => element.props['aria-label'] === 'iCloud / Notes').props.disabled).toBe(true);
  expect(find(tree, element => element.props['aria-label'] === 'Refresh Apple Notes').props.disabled).toBe(true);
  expect(find(tree, element => element.props['aria-label'] === 'Attach to conversation').props.disabled).toBe(true);
  expect(find(tree, element => element.props['aria-label'] === 'Delete note').props.disabled).toBe(true);
  click(tree, element => element.props['aria-label'] === 'Refresh Apple Notes');
  expect(app.refreshes).toEqual([]);
});

test('folder accordion collapses and reopens without fetching or losing search and preview', () => {
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })), onAttach: async () => true }));
  const folderButton = (element: ReactElement<Record<string, unknown>>) => element.props['aria-label'] === 'iCloud / Notes';
  const notesRegion = (element: ReactElement<Record<string, unknown>>) => element.props.role === 'region' && element.props['aria-label'] === 'Notes';
  expect(elements(render()).some(folderField)).toBe(false);
  change(render(), element => element.props.type === 'search', 'title');
  expect(find(render(), folderButton).props['aria-expanded']).toBe(true);
  click(render(), folderButton);
  expect(find(render(), folderButton).props['aria-expanded']).toBe(false);
  expect(elements(render()).some(notesRegion)).toBe(false);
  expect(find(render(), element => element.type === 'note-editor').props.note).toBe(note);
  click(render(), folderButton);
  expect(find(render(), folderButton).props['aria-controls']).toBe(find(render(), notesRegion).props.id);
  expect(find(render(), element => element.props.type === 'search').props.value).toBe('title');
  expect(app.selectedFolders).toEqual([]);
  expect(app.refreshes).toEqual([]);
  click(find(render(), notesRegion), element => element.type === 'button' && element.props.title === note.title);
  expect(app.selectedNotes).toEqual([note.id]);
});

test('folder accordion switches by id, resets search and only shows the selected folder notes', () => {
  const browserState = state();
  browserState.folders.push({ id: 'local', name: 'Notes', path: 'Notes', account: 'On My Mac', isDefault: false });
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser', browserState);
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })), onAttach: async () => true }));
  const localFolder = (element: ReactElement<Record<string, unknown>>) => element.props['aria-label'] === 'On My Mac / Notes';
  change(render(), element => element.props.type === 'search', 'title');
  click(render(), localFolder);
  expect(app.selectedFolders).toEqual(['local']);
  expect(find(render(), element => element.props.type === 'search').props.value).toBe('');
  Object.assign(browserState, { folderId: 'local', notes: [], note: null, selectedId: '', loadingNotes: true });
  expect(find(render(), localFolder).props['aria-expanded']).toBe(true);
  expect(find(render(), element => element.props['aria-label'] === 'iCloud / Notes').props['aria-expanded']).toBe(false);
  expect(elements(render()).some(element => element.props.title === note.title)).toBe(false);
  expect(find(render(), element => element.props.role === 'status').props.children).toBe('Loading notes…');
  browserState.loadingNotes = false;
  expect(elements(render()).some(element => element.props.children === 'This folder has no notes.')).toBe(true);
});

test('header refresh uses the current browser and stays disabled while loading or attaching', async () => {
  const browserState = state();
  const pending = createDeferred<boolean>();
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser', browserState);
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })),
    onAttach: async () => pending.promise, renderHeader: (refresh, create, search) => <header>{search}{refresh}{create}</header> }));
  const refreshButton = (element: ReactElement<Record<string, unknown>>) => element.props['aria-label'] === 'Refresh Apple Notes';
  const header = find(render(), element => element.type === 'header');
  expect(find(header, refreshButton).props.disabled).toBe(false);
  click(header, refreshButton);
  expect(app.refreshes).toEqual([true]);
  browserState.loadingFolders = true;
  expect(find(render(), refreshButton).props.disabled).toBe(true);
  browserState.loadingFolders = false;
  click(render(), element => element.props['aria-label'] === 'Attach to conversation');
  expect(find(render(), refreshButton).props.disabled).toBe(true);
  expect(find(render(), element => element.props['aria-label'] === '새 메모').props.disabled).toBe(true);
  const folderButton = (element: ReactElement<Record<string, unknown>>) => element.props['aria-label'] === 'iCloud / Notes';
  expect(find(render(), folderButton).props.disabled).toBe(true);
  click(render(), folderButton);
  expect(find(render(), folderButton).props['aria-expanded']).toBe(true);
  pending.resolve(true);
  await flush();
  expect(find(render(), refreshButton).props.disabled).toBe(false);
  expect(find(render(), element => element.props['aria-label'] === '새 메모').props.disabled).toBe(false);
});

test('delete confirmation escapes the title, supports cancellation, and waits for one acknowledged request', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteDeleted>>();
  const calls: string[] = [];
  let cancelled = 0;
  let deleted = 0;
  const notesApi = api(async () => ({ ok: true, value: { id: 'new', title: 'New' } }));
  notesApi.delete = async id => { calls.push(id); return pending.promise; };
  const app = harness<typeof AppleNotesDeleteDialog>('AppleNotesDeleteDialog.tsx', 'AppleNotesDeleteDialog');
  const render = () => app.render(component => component({ api: notesApi, note, onClose() { cancelled += 1; }, onDeleted() { deleted += 1; } }));
  expect(renderToStaticMarkup(find(render(), element => element.type === 'strong'))).toContain('&lt;script&gt;title&lt;/script&gt;');
  expect(calls).toEqual([]);
  click(render(), element => element.props.children === '취소');
  expect(cancelled).toBe(1);
  expect(calls).toEqual([]);
  const tree = render();
  click(tree, element => element.props.children === '삭제');
  click(tree, element => element.props.children === '삭제');
  expect(calls).toEqual([note.id]);
  expect(deleted).toBe(0);
  expect(find(render(), element => element.type === 'modal').props.closeDisabled).toBe(true);
  pending.resolve({ ok: true, value: { id: note.id } });
  await flush();
  expect(deleted).toBe(1);
});

test('delete errors keep the confirmation open and an uncertain result blocks further attempts', async () => {
  const notesApi = api(async () => ({ ok: true, value: { id: 'new', title: 'New' } }));
  let calls = 0;
  notesApi.delete = async () => {
    calls += 1;
    return calls === 1 ? { ok: false, error: { code: 'permission', message: 'Allow Notes automation.' } }
      : { ok: false, error: { code: 'delete-unknown', message: contract.APPLE_NOTES_DELETE_UNKNOWN_MESSAGE } };
  };
  const app = harness<typeof AppleNotesDeleteDialog>('AppleNotesDeleteDialog.tsx', 'AppleNotesDeleteDialog');
  const render = () => app.render(component => component({ api: notesApi, note, onClose() {}, onDeleted() { throw new Error('Unexpected success'); } }));
  click(render(), element => element.props.children === '삭제');
  await flush();
  expect(find(render(), element => element.props.role === 'alert').props.children).toBe('Allow Notes automation.');
  expect(find(render(), element => element.type === 'strong').props.children).toBe(note.title);
  click(render(), element => element.props.children === '삭제');
  await flush();
  expect(find(render(), element => element.props.children === '삭제').props.disabled).toBe(true);
  click(render(), element => element.props.children === '삭제');
  expect(calls).toBe(2);
});

test('late delete acknowledgement does not update a view after unmount', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteDeleted>>();
  const notesApi = api(async () => ({ ok: true, value: { id: 'new', title: 'New' } }));
  notesApi.delete = async () => pending.promise;
  let deleted = 0;
  const app = harness<typeof AppleNotesDeleteDialog>('AppleNotesDeleteDialog.tsx', 'AppleNotesDeleteDialog');
  click(app.render(component => component({ api: notesApi, note, onClose() {}, onDeleted() { deleted += 1; } })),
    element => element.props.children === '삭제');
  app.unmount();
  pending.resolve({ ok: true, value: { id: note.id } });
  await flush();
  expect(deleted).toBe(0);
});

test('notes page removes the acknowledged delete target without reloading or clearing search', () => {
  const browserState = state();
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser', browserState);
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'New' } })), onAttach: async () => true }));
  change(render(), element => element.props.type === 'search', 'title');
  const deleteButton = (element: ReactElement<Record<string, unknown>>) => element.props['aria-label'] === 'Delete note';
  click(render(), deleteButton);
  let dialog = find(render(), element => element.type === 'delete-dialog');
  if (typeof dialog.props.onClose !== 'function') throw new Error('Missing cancel callback.');
  dialog.props.onClose();
  expect(app.selectedFolders).toEqual([]);
  expect(elements(render()).some(element => element.type === 'delete-dialog')).toBe(false);
  click(render(), deleteButton);
  browserState.note = { ...note, id: 'different' };
  browserState.folderId = 'different-folder';
  dialog = find(render(), element => element.type === 'delete-dialog');
  expect(dialog.props.note).toBe(note);
  if (typeof dialog.props.onDeleted !== 'function') throw new Error('Missing delete callback.');
  dialog.props.onDeleted();
  expect(app.selectedFolders).toEqual([]);
  expect(app.removedNotes).toEqual([{ folderId: 'folder', noteId: note.id }]);
  expect(find(render(), element => element.props.type === 'search').props.value).toBe('title');
  expect(elements(render()).some(element => element.type === 'delete-dialog')).toBe(false);
  expect(find(render(), element => element.props.role === 'status').props.children).toBe('Deleted from Apple Notes.');
});

test('composing preserves input after a failed save and sends one request when retried', async () => {
  const browserState = state();
  browserState.folders.push({ id: 'other', name: 'Work', account: 'iCloud', path: 'Work', isDefault: false });
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  const calls: contract.AppleNoteCreateInput[] = [];
  const savedFolders: string[] = [];
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveDialog.tsx', 'AppleNotesSaveDialog', browserState);
  const notesApi = api(async input => {
    calls.push(input);
    return calls.length === 1 ? { ok: false, error: { code: 'permission', message: 'Allow Notes automation.' } } : pending.promise;
  });
  const render = () => app.render(component => component({ api: notesApi, mode: 'compose', initialTitle: '', body: '',
    initialFolderId: 'other', onClose() {}, onSaved: folderId => { savedFolders.push(folderId); } }));
  expect(find(render(), folderField).props.value).toBe('other');
  expect(find(render(), element => element.props.type === 'submit').props.disabled).toBe(true);
  submit(render());
  expect(calls).toHaveLength(0);
  change(render(), titleField, '  새 메모 제목  ');
  submit(render());
  expect(calls).toHaveLength(0);
  change(render(), bodyField, '첫째 줄\n\n둘째 줄');
  change(render(), folderField, 'folder');
  submit(render());
  await flush();
  expect(find(render(), element => element.props.role === 'alert').props.children).toBe('Allow Notes automation.');
  expect(find(render(), titleField).props.value).toBe('  새 메모 제목  ');
  expect(find(render(), bodyField).props.value).toBe('첫째 줄\n\n둘째 줄');
  expect(find(render(), folderField).props.value).toBe('folder');
  expect(savedFolders).toEqual([]);
  const retry = render();
  submit(retry); submit(retry);
  expect(calls).toEqual(Array.from({ length: 2 }, () => ({ folderId: 'folder', title: '새 메모 제목', body: '첫째 줄\n\n둘째 줄' })));
  expect(find(render(), bodyField).props.disabled).toBe(true);
  expect(find(render(), element => element.type === 'modal').props.closeDisabled).toBe(true);
  pending.resolve({ ok: true, value: { id: 'new', title: '새 메모 제목' } });
  await flush();
  expect(savedFolders).toEqual(['folder']);
});

test('an uncertain new-note save retains the draft and cannot be retried immediately', async () => {
  let calls = 0;
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveDialog.tsx', 'AppleNotesSaveDialog');
  const notesApi = api(async () => { calls += 1; throw new Error('IPC disconnected'); });
  const render = () => app.render(component => component({ api: notesApi, mode: 'compose', initialTitle: '', body: '',
    onClose() {}, onSaved() { throw new Error('Unexpected success'); } }));
  change(render(), titleField, 'Title');
  change(render(), bodyField, 'Draft');
  submit(render());
  await flush();
  expect(find(render(), bodyField).props.value).toBe('Draft');
  expect(find(render(), element => element.props.role === 'alert').props.children).toBe(contract.APPLE_NOTES_SAVE_UNKNOWN_MESSAGE);
  expect(find(render(), element => element.props.type === 'submit').props.disabled).toBe(true);
  submit(render());
  expect(calls).toBe(1);
});

test('new note closes only on acknowledgement and reloads the saved folder with search cleared', () => {
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'Title' } })),
    onAttach: async () => true, renderHeader: (refresh, create, search) => <header>{search}{refresh}{create}</header> }));
  change(render(), element => element.props.type === 'search', 'old search');
  click(find(render(), element => element.type === 'header'), element => element.props['aria-label'] === '새 메모');
  const dialog = find(render(), element => element.type === 'save-dialog');
  expect(dialog.props.initialFolderId).toBe('folder');
  expect(dialog.props.mode).toBe('compose');
  expect(app.selectedFolders).toEqual([]);
  if (typeof dialog.props.onSaved !== 'function') throw new Error('Missing saved callback.');
  dialog.props.onSaved('other');
  expect(app.selectedFolders).toEqual(['other']);
  expect(app.reloadedFolders).toEqual(['other']);
  expect(elements(render()).some(element => element.type === 'save-dialog')).toBe(false);
  expect(find(render(), element => element.props.type === 'search').props.value).toBe('');
  expect(find(render(), element => element.props.role === 'status').props.children).toBe('Saved to Apple Notes.');
});

test('saving a response submits exactly once and waits for acknowledgement before closing', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  const calls: contract.AppleNoteCreateInput[] = [];
  let saved = 0;
  const props = { api: api(async input => { calls.push(input); return pending.promise; }),
    initialTitle: 'Conversation', body: 'Answer', onClose() {}, onSaved() { saved += 1; } };
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveDialog.tsx', 'AppleNotesSaveDialog');
  const render = () => app.render(component => component(props));
  const tree = render();
  submit(tree); submit(tree);
  expect(calls).toEqual([{ folderId: 'folder', title: 'Conversation', body: 'Answer' }]);
  expect(saved).toBe(0);
  expect(find(render(), element => element.type === 'modal').props.closeDisabled).toBe(true);
  pending.resolve({ ok: true, value: { id: 'created', title: 'Conversation' } });
  await flush();
  expect(saved).toBe(1);
});

test('an uncertain save shows its message and prevents an immediate duplicate retry', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  let calls = 0;
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveDialog.tsx', 'AppleNotesSaveDialog');
  const render = () => app.render(component => component({ api: api(async () => { calls += 1; return pending.promise; }),
    initialTitle: 'Conversation', body: 'Answer', onClose() {}, onSaved() { throw new Error('Unexpected success'); } }));
  submit(render());
  pending.resolve({ ok: false, error: { code: 'save-unknown', message: 'Check Notes before saving again.' } });
  await flush();
  const tree = render();
  expect(find(tree, element => element.props.role === 'alert').props.children).toBe('Check Notes before saving again.');
  expect(find(tree, element => element.props.type === 'submit').props.disabled).toBe(true);
  submit(tree);
  expect(calls).toBe(1);
});

test('saving does not close a different view after its dialog unmounts', async () => {
  const pending = createDeferred<contract.AppleNotesReply<contract.AppleNoteCreated>>();
  let saved = 0;
  const app = harness<typeof AppleNotesSaveDialog>('AppleNotesSaveDialog.tsx', 'AppleNotesSaveDialog');
  submit(app.render(component => component({ api: api(async () => pending.promise), initialTitle: 'Conversation', body: 'Answer',
    onClose() {}, onSaved() { saved += 1; } })));
  app.unmount();
  pending.resolve({ ok: true, value: { id: 'created', title: 'Conversation' } });
  await flush();
  expect(saved).toBe(0);
});

test('notes page passes the selected snapshot to the editor and waits for attachment acknowledgement', async () => {
  const pending = createDeferred<boolean>();
  const attached: contract.AppleNote[] = [];
  let completed = 0;
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'Title' } })),
    onAttach: async value => { attached.push(value); const result = await pending.promise; if (result) completed += 1; return result; } }));
  const tree = render();
  expect(find(tree, element => element.type === 'note-editor').props.note).toBe(note);
  const button = find(tree, element => element.props['aria-label'] === 'Attach to conversation');
  if (typeof button.props.onClick !== 'function') throw new Error('Missing attachment action.');
  button.props.onClick(); button.props.onClick();
  expect(attached).toEqual([note]);
  expect(completed).toBe(0);
  pending.resolve(true);
  await flush();
  expect(completed).toBe(1);
});

test('notes page keeps the preview and shows an error when attachment is refused', async () => {
  const app = harness<typeof AppleNotesBrowser>('AppleNotesBrowser.tsx', 'AppleNotesBrowser');
  let calls = 0;
  let attachmentDisabled = true;
  const render = () => app.render(component => component({ api: api(async () => ({ ok: true, value: { id: 'new', title: 'Title' } })),
    attachmentDisabled, onAttach: async () => { calls += 1; return false; } }));
  const button = find(render(), element => element.props['aria-label'] === 'Attach to conversation');
  expect(button.props.disabled).toBe(true);
  if (typeof button.props.onClick !== 'function') throw new Error('Missing attachment action.');
  button.props.onClick();
  expect(calls).toBe(0);
  attachmentDisabled = false;
  const enabled = find(render(), element => element.props['aria-label'] === 'Attach to conversation');
  if (typeof enabled.props.onClick !== 'function') throw new Error('Missing attachment action.');
  enabled.props.onClick();
  await flush();
  expect(calls).toBe(1);
  expect(find(render(), element => element.props.role === 'alert').props.children).toContain('Could not attach');
  expect(find(render(), element => element.type === 'note-editor').props.note).toBe(note);
});
