import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import * as react from 'react';
import * as reactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { AppleNotesApi, AppleNotesFolder } from '../shared/apple-notes';
import type { AppleNoteDocument } from '../shared/apple-notes-document';
import type { NotesView } from '../frontend/src/features/notes/NotesView';

async function notesViewWithApi(api: AppleNotesApi) {
  // Inject only the native bridge; exercise the real view, hooks, browser and portals.
  const modules: Record<string, unknown> = {
    react, 'react-dom': reactDOM, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
    '../../cheshiDesktop': { cheshiDesktop: { appleNotes: api } },
    '../../shared/ui': await import('../frontend/src/shared/ui'),
    './AppleNotesBrowser': await import('../frontend/src/features/notes/AppleNotesBrowser'),
    './AppleNotes.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/notes/NotesView.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: { NotesView?: typeof NotesView } = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected NotesView dependency: ${name}`);
    return modules[name];
  } });
  if (!exports.NotesView) throw new Error('NotesView export is unavailable');
  return exports.NotesView;
}

test('Memo preloads before its first visit, shows pending UI in a late sidebar portal and retains state across scenes', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    DOMParser: window.DOMParser, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const sidebar = document.createElement('aside');
  const content = document.createElement('div');
  document.body.append(sidebar, content);
  const root = createRoot(content);
  const note: AppleNoteDocument = { id: 'note', title: 'Selected memo', plaintext: 'Memo body', html: '<p>Memo body</p>',
    modifiedAt: '2026-09-16T00:00:00Z', locked: false, attachmentCount: 0 };
  let folderReads = 0, bodyReads = 0, opened = 0;
  let resolveFolders!: (folders: AppleNotesFolder[]) => void;
  const pendingFolders = new Promise<AppleNotesFolder[]>(resolve => { resolveFolders = resolve; });
  const api: AppleNotesApi = {
    available: true,
    open: async () => {},
    folders: async () => { folderReads++; return pendingFolders; },
    list: async () => ({ notes: [note], nextOffset: null }),
    read: async () => { bodyReads++; return note; }, document: async () => { bodyReads++; return note; },
    update: async () => { throw new Error('Unexpected save'); },
    create: async () => { throw new Error('Unexpected create'); },
    delete: async () => { throw new Error('Unexpected delete'); },
  };
  const View = await notesViewWithApi(api);
  const render = async (active: boolean, sidebarTarget: HTMLElement | null = sidebar) => {
    await act(async () => root.render(<View active={active} sidebarTarget={sidebarTarget}
      onAttach={async () => false} attachmentDisabled={false} rightSidebarOpen={false}
      onToggleRightSidebar={() => {}} onOpen={() => { opened++; }} />));
  };
  try {
    await render(false, null);
    expect(folderReads).toBe(1);
    expect(content.querySelector('main')?.hidden).toBe(true);
    await render(false);
    const folders = sidebar.querySelector('[aria-label="Memo folders"]')!;
    const input = sidebar.querySelector<HTMLInputElement>('[aria-label="Search all notes"]')!;
    expect(input.placeholder).toBe('Search…');
    expect(folders.textContent).toContain('MEMO');
    expect(folders.querySelector('[role="search"]')).not.toBeNull();
    expect(content.querySelector('[role="search"]')).toBeNull();
    expect(content.querySelector('[aria-label="Memo folders"]')).toBeNull();
    expect(sidebar.querySelector('[aria-label="Refresh Apple Notes"]')).not.toBeNull();
    expect(sidebar.querySelector('[role="status"][aria-label="Loading notes…"]')).not.toBeNull();
    await act(async () => resolveFolders([{ id: 'folder', name: 'Notes', path: 'Notes', account: 'iCloud', isDefault: true }]));
    expect(sidebar.querySelector('[aria-label="iCloud / Notes"]')).not.toBeNull();
    expect(bodyReads).toBe(0);
    expect(folderReads).toBe(1);
    await render(false);
    expect(sidebar.querySelector('[aria-label="Search all notes"]')).toBe(input);
    await act(async () => sidebar.querySelector<HTMLButtonElement>('[aria-label="iCloud / Notes"]')!.click());
    const row = sidebar.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(row.hasAttribute('title')).toBe(false);
    await act(async () => row.click());
    expect(opened).toBe(1);
    await render(true);
    const editor = content.querySelector('[role="textbox"]')!;
    expect(editor.textContent).toBe('Memo body');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    await render(false);
    await render(true);
    expect(sidebar.querySelector('[aria-label="Search all notes"]')).toBe(input);
    expect(content.querySelector('[role="textbox"]')).toBe(editor);
    expect(folderReads).toBe(1);
    expect(bodyReads).toBeGreaterThan(0);
  } finally {
    await act(async () => root.unmount());
    expect(sidebar.childNodes).toHaveLength(0);
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
