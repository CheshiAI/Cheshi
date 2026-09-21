import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isValidElement, type ComponentProps, type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import type { AppShell } from '../frontend/src/features/shell/AppShell';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import type { SplitPaneLayout } from '../frontend/src/shared/ui/SplitPaneLayout';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { WorkspaceEditor } from '../frontend/src/features/editor/WorkspaceEditor';
import type { ChatWorkspace } from '../frontend/src/features/chat/ChatWorkspace';
import type { WorkspaceFileSearch } from '../frontend/src/features/navigation/WorkspaceFileSearch';
import type { CodeGraphView } from '../frontend/src/features/graph/CodeGraphView';
import * as draftAttachmentModule from '../frontend/src/features/chat/chatDraftAttachments';
import { appleNoteAttachment } from '../frontend/src/features/notes/appleNotesModel';
import type { NotesView } from '../frontend/src/features/notes/NotesView';
import type { AppleNote } from '../shared/apple-notes';
import type { TerminalWorkspace } from '../frontend/src/features/terminal/TerminalWorkspace';
import type { ReviewSidebar } from '../frontend/src/features/shell/ReviewSidebar';

function hooks() {
  const slots: unknown[] = [];
  const dependencies: (readonly unknown[] | undefined)[] = [];
  const pending: (() => void)[] = [];
  let cursor = 0;
  let effectIndex = 0;
  function effect(run: () => void, deps: readonly unknown[]) {
    const index = effectIndex++;
    const previous = dependencies[index];
    if (previous && previous.length === deps.length && deps.every((value, i) => Object.is(value, previous[i]))) return;
    dependencies[index] = deps;
    pending.push(run);
  }
  return {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useRef(current: unknown) { return slots[cursor++] ??= { current }; },
      useCallback(callback: unknown) { return callback; },
      useEffect: effect, useLayoutEffect: effect,
    },
    render<T>(run: () => T) {
      cursor = 0; effectIndex = 0;
      const result = run();
      pending.splice(0).forEach(effect => effect());
      return result;
    },
  };
}

function load<T>(path: string, name: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
  });
  vm.runInNewContext(compiled.outputText, { exports, ...globals, require: (dependency: string) => {
    if (dependency === 'react/jsx-runtime') return jsxRuntime;
    if (dependency.endsWith('.module.css')) return { default: new Proxy({}, { get: (_target, key) => key }) };
    if (!Object.hasOwn(modules, dependency)) throw new Error(`Unexpected dependency: ${dependency}`);
    return modules[dependency];
  } });
  return exports[name] as T;
}

function elements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function props<T>(tree: ReactNode, name: string): T {
  const node = elements(tree).find(element => element.type === name);
  if (!node) throw new Error(`Missing component: ${name}`);
  return node.props as T;
}

function shellHarness() {
  const app = hooks();
  let openSearch = () => {};
  const attachments = draftAttachmentModule.createChatDraftAttachments();
  const modules: Record<string, unknown> = {
    react: app.react,
    '../chat/HistoryRecallActivity': { HistoryRecallNavigation: { Provider: 'HistoryRecallNavigation' } },
    '../chat/chatDraftAttachments': { ...draftAttachmentModule, createChatDraftAttachments: () => attachments },
    '../notes/appleNotesModel': { appleNoteAttachment },
    '../chat/useChatWorkspace': { useChatWorkspace: () => ({ activePaneId: 'chat-a', controllers: {}, activeController: { state: { phase: 'ready' } }, relay: { running: false },
      sessionHistory: { loading: false, sessions: [] }, responseThreadIds: [], accountSwitchPending: false }) },
    '../chat/useChatHistorySearch': { useChatHistorySearch: () => ({ clear() {} }) },
    './useAppUpdateResume': { useAppUpdateResume: () => ({ busy: false, error: null }) },
    './useSidebarResize': { useSidebarResize: () => ({ layoutRef: { current: null }, style: {}, resizing: null,
      separatorProps: (side: string) => ({ role: 'separator', 'aria-label': `Resize ${side} sidebar` }) }) },
    '../navigation/fileSearchShortcut': { installFileSearchShortcut: (_document: unknown, open: () => void) => {
      openSearch = open; return () => {};
    } },
  };
  for (const [path, names] of Object.entries({
    '../../shared/ui': ['LiquidGlassPanel'], '../chat': ['ChatSessionList'], '../chat/ChatWorkspace': ['ChatWorkspace'],
    '../chat/TemporaryChatPanel': ['TemporaryChatPanel'], '../chat/ChatDeleteSessionDialog': ['ChatDeleteSessionDialog'],
    '../chat/ChatHistoryOpenDialog': ['ChatHistoryOpenDialog'], '../chat/ChatHistorySearchBar': ['ChatHistorySearchBar'],
    '../chat/ChatHistorySearchPage': ['ChatHistorySearchPage'], '../chrome/WindowChrome': ['WindowChrome', 'WindowTabs'],
    '../editor': ['WorkspaceEditor'], '../git': ['GitWorkspace'], '../graph': ['CodeGraphView'],
    '../home/BlankView': ['BlankView'], '../navigation/Sidebar': ['Sidebar'], '../plugins': ['PluginsView'],
    '../terminal': ['TerminalWorkspace'], '../showcase/ShowcaseView': ['ShowcaseView'],
    '../settings/SettingsView': ['SettingsView'],
    './ReviewSidebar': ['ReviewSidebar'], './WorkspaceStatusBar': ['WorkspaceStatusBar'],
    '../editor/LocalHistoryPage': ['LocalHistoryPage'], './WorkspaceEditorSplit': ['WorkspaceEditorSplit'],
    '../navigation/WorkspaceFileSearch': ['WorkspaceFileSearch'], '../notes/NotesView': ['NotesView'],
  })) modules[path] = Object.fromEntries(names.map(name => [name, name]));
  const Shell = load<typeof AppShell>('features/shell/AppShell.tsx', 'AppShell', modules, { document: {} });
  return { attachments, render: () => app.render(() => Shell()), openSearch: () => openSearch() };
}

test('file search keeps the current page until a result opens in the standalone editor', () => {
  const app = shellHarness();
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('git');
  app.openSearch();
  let tree = app.render();
  const search = props<ComponentProps<typeof WorkspaceFileSearch>>(tree, 'WorkspaceFileSearch');
  search.onClose();
  tree = app.render();
  expect(elements(tree).some(element => element.type === 'WorkspaceFileSearch')).toBe(false);
  expect(elements(tree).some(element => element.type === 'GitWorkspace')).toBe(true);
  app.openSearch();
  const reopened = props<ComponentProps<typeof WorkspaceFileSearch>>(app.render(), 'WorkspaceFileSearch');
  reopened.onOpenFile('src/found.ts'); reopened.onClose();
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(split.mode).toBe('editor');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor').target?.path).toBe('src/found.ts');
  expect(elements(split.children).some(element => element.type === 'GitWorkspace')).toBe(false);
});

test('Explorer file opening keeps the chat visible and reuses the same editor for subsequent files', () => {
  const app = shellHarness();
  let tree = app.render();
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit').mode).toBe('primary');
  props<ComponentProps<typeof Sidebar>>(tree, 'Sidebar').onOpenWorkspaceFile('first.ts');
  tree = app.render();
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit');
  expect(split.mode).toBe('split');
  expect(props<ComponentProps<typeof ChatWorkspace>>(split.children, 'ChatWorkspace').active).toBe(true);
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor')).toMatchObject({
    active: true, target: { path: 'first.ts', requestId: 1 },
  });
  props<ComponentProps<typeof Sidebar>>(tree, 'Sidebar').onOpenWorkspaceFile('second.ts');
  const next = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(next.mode).toBe('split');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(next.editor, 'WorkspaceEditor').target?.path).toBe('second.ts');
  expect(props<ComponentProps<typeof ChatWorkspace>>(next.children, 'ChatWorkspace').active).toBe(true);
});

test('closing the final tab restores the current page and does not reopen the closed target', () => {
  const app = shellHarness();
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('git');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(split.mode).toBe('editor');
  props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor').onAllTabsClosed();
  const closed = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(closed.mode).toBe('primary');
  expect(elements(closed.children).some(element => element.type === 'GitWorkspace')).toBe(true);
  expect(props<ComponentProps<typeof WorkspaceEditor>>(closed.editor, 'WorkspaceEditor')).toMatchObject({ active: false, target: null });
});

test('page and editor portal hosts stay stable through split, resize, collapse and reopening', () => {
  const app = hooks();
  const portals: { children: ReactNode; host: object; key: string }[] = [];
  const Split = load<typeof WorkspaceEditorSplit>('features/shell/WorkspaceEditorSplit.tsx', 'WorkspaceEditorSplit', {
    react: app.react,
    'react-dom': { createPortal(children: ReactNode, host: object, key: string) { portals.push({ children, host, key }); return null; } },
    '../../shared/ui/SplitPaneLayout': { SplitPaneLayout: 'SplitPaneLayout' },
  }, { document: { createElement: () => ({ className: '' }) } });
  const page = <textarea defaultValue="unsent chat" />;
  const editor = <textarea defaultValue="unsaved file" />;
  const render = (mode: ComponentProps<typeof WorkspaceEditorSplit>['mode']) => app.render(() => Split({ mode, children: page, editor }));
  render('primary');
  const original = portals.slice();
  let layout = props<ComponentProps<typeof SplitPaneLayout>>(render('split'), 'SplitPaneLayout');
  expect(layout.layout).toMatchObject({ type: 'split', axis: 'columns', ratio: 0.5,
    first: { paneId: 'editor' }, second: { paneId: 'primary' } });
  layout.onResizeSplit('workspace-editor', 0.7);
  layout = props<ComponentProps<typeof SplitPaneLayout>>(render('split'), 'SplitPaneLayout');
  expect(layout.layout).toMatchObject({ ratio: 0.7 });
  const collapsed = props<ComponentProps<typeof SplitPaneLayout>>(render('editor'), 'SplitPaneLayout');
  expect(collapsed.collapsedPane).toBe('second');
  expect(collapsed.layout).toMatchObject({ type: 'split', ratio: 0.7 });
  const reopened = props<ComponentProps<typeof SplitPaneLayout>>(render('split'), 'SplitPaneLayout');
  expect(reopened.collapsedPane).toBeNull();
  expect(reopened.layout).toMatchObject({ ratio: 0.7 });
  const fullPage = props<ComponentProps<typeof SplitPaneLayout>>(render('page'), 'SplitPaneLayout');
  expect(fullPage.collapsedPane).toBe('first');
  expect(fullPage.layout).toMatchObject({ type: 'split', ratio: 0.7 });
  expect(props<ComponentProps<typeof SplitPaneLayout>>(render('split'), 'SplitPaneLayout').layout).toMatchObject({ ratio: 0.7 });
  render('primary');
  expect(props<ComponentProps<typeof SplitPaneLayout>>(render('split'), 'SplitPaneLayout').layout).toMatchObject({ ratio: 0.5 });
  for (const portal of portals) {
    const expected = original.find(item => item.key === portal.key)!;
    expect(portal.host).toBe(expected.host);
    expect(portal.children).toBe(expected.children);
  }
});

test('the shared separator updates the split continuously while dragging and commits on release', () => {
  const app = hooks();
  const Layout = load<typeof SplitPaneLayout>('shared/ui/SplitPaneLayout.tsx', 'SplitPaneLayout', { react: app.react });
  const committed: number[] = [];
  const options: ComponentProps<typeof SplitPaneLayout> = {
    layout: { type: 'split', id: 'workspace-editor', axis: 'columns', ratio: 0.5,
      first: { type: 'pane', paneId: 'editor' }, second: { type: 'pane', paneId: 'primary' } },
    renderPane: id => <div>{id}</div>, onResizeSplit: (_id, ratio) => committed.push(ratio),
  };
  const element = Layout(options);
  if (typeof element.type !== 'function') throw new Error('Expected split component');
  // Execute the real shared split handlers with only the DOM geometry and pointer boundary replaced.
  const Component = element.type as (props: typeof options) => ReactElement;
  const render = () => app.render(() => Component(options));
  const first = render() as ReactElement<{ ref: { current: HTMLDivElement | null } }>;
  first.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1001, height: 600 }) } as HTMLDivElement;
  const separator = (tree: ReactNode) => {
    const found = elements(tree).find(node => (node.props as HTMLAttributes<HTMLDivElement>).role === 'separator');
    if (!found) throw new Error('Missing resize separator');
    return found.props as HTMLAttributes<HTMLDivElement>;
  };
  let captured = false;
  const pointer = (clientX: number): PointerEvent<HTMLDivElement> => ({
    button: 0, pointerId: 7, clientX, clientY: 0, preventDefault() {}, stopPropagation() {},
    currentTarget: { setPointerCapture() { captured = true; }, hasPointerCapture: () => captured,
      releasePointerCapture() { captured = false; } },
  }) as unknown as PointerEvent<HTMLDivElement>;
  separator(first).onPointerDown?.(pointer(500.5));
  separator(render()).onPointerMove?.(pointer(700.5));
  expect((render().props as { style: CSSProperties }).style.gridTemplateColumns).toContain('0.7fr');
  expect(committed).toEqual([]);
  separator(render()).onPointerUp?.(pointer(700.5));
  expect(committed).toEqual([0.7]);
  expect(captured).toBe(false);
});


test('restored file sessions reveal the editor split without an Explorer click', () => {
  const app = shellHarness();
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor').onSessionRestored?.();
  const restored = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(restored.mode).toBe('split');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(restored.editor, 'WorkspaceEditor').active).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(restored.children, 'ChatWorkspace').active).toBe(true);
});

test('closing Codex keeps file tabs and sidebar controls, and navigation restores the split', () => {
  const app = shellHarness();
  const initial = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(props<ComponentProps<typeof ChatWorkspace>>(initial.children, 'ChatWorkspace').onCloseWorkspace).toBeUndefined();
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const chat = props<ComponentProps<typeof ChatWorkspace>>(split.children, 'ChatWorkspace');
  chat.onCloseWorkspace!();
  const closed = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(closed.mode).toBe('editor');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(closed.editor, 'WorkspaceEditor')).toMatchObject({
    active: true, target: { path: 'first.ts', requestId: 1 },
  });
  expect(props<ComponentProps<typeof ChatWorkspace>>(closed.children, 'ChatWorkspace').active).toBe(false);
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('second.ts');
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit').mode).toBe('editor');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('chat');
  const reopened = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(reopened.mode).toBe('split');
  const resumed = props<ComponentProps<typeof ChatWorkspace>>(reopened.children, 'ChatWorkspace');
  expect(resumed.active).toBe(true);
  expect(resumed.rightSidebarOpen).toBe(true);
  resumed.onToggleRightSidebar();
  resumed.onCloseWorkspace!();
  props<ComponentProps<typeof WorkspaceEditor>>(reopened.editor, 'WorkspaceEditor').onAllTabsClosed();
  const empty = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(empty.mode).toBe('primary');
  expect(props<ComponentProps<typeof ChatWorkspace>>(empty.children, 'ChatWorkspace')).toMatchObject({
    active: true, rightSidebarOpen: false, onCloseWorkspace: undefined,
  });
});

test('collapsed split keeps both panes mounted while hiding the separator and disabling the closed region', () => {
  const app = hooks();
  const Layout = load<typeof SplitPaneLayout>('shared/ui/SplitPaneLayout.tsx', 'SplitPaneLayout', { react: app.react });
  const options: ComponentProps<typeof SplitPaneLayout> = {
    layout: { type: 'split', id: 'workspace-editor', axis: 'columns', ratio: 0.7,
      first: { type: 'pane', paneId: 'editor' }, second: { type: 'pane', paneId: 'primary' } },
    renderPane: id => <div>{id}</div>, onResizeSplit() {}, collapsedPane: 'second',
  };
  const element = Layout(options);
  const Component = element.type as (props: typeof options) => ReactElement;
  const tree = app.render(() => Component(options));
  const attrs = elements(tree).map(node => node.props as HTMLAttributes<HTMLDivElement>);
  expect(attrs[0]!.style?.gridTemplateColumns).toBe('minmax(0, 1fr) 0px minmax(0, 0fr)');
  expect(attrs.find(node => node.role === 'separator')?.hidden).toBe(true);
  expect(attrs.filter(node => node.inert)).toHaveLength(1);
  expect(attrs.find(node => node.inert)?.['aria-hidden']).toBe(true);
  expect(elements(tree).filter(node => node.type === Layout)).toHaveLength(2);
  const reopened = app.render(() => Component({ ...options, collapsedPane: null }));
  const reopenedAttrs = elements(reopened).map(node => node.props as HTMLAttributes<HTMLDivElement>);
  expect(reopenedAttrs[0]!.style?.gridTemplateColumns).toContain('0.7fr');
  expect(reopenedAttrs.some(node => node.inert)).toBe(false);
  expect(reopenedAttrs.find(node => node.role === 'separator')?.hidden).toBe(false);
});

test('only the standalone editor controls the shared right sidebar and preserves its state on reopening Codex', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
  expect(editor().onToggleRightSidebar).toBeUndefined();
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
  expect(editor().onToggleRightSidebar).toBeUndefined();
  props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').onCloseWorkspace!();
  expect(split().mode).toBe('editor');
  expect(editor().rightSidebarOpen).toBe(true);
  editor().onToggleRightSidebar!();
  expect(editor().rightSidebarOpen).toBe(false);
  editor().onToggleRightSidebar!();
  expect(editor().rightSidebarOpen).toBe(true);
  editor().onToggleRightSidebar!();
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('chat');
  expect(split().mode).toBe('split');
  expect(editor().onToggleRightSidebar).toBeUndefined();
  const chat = props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace');
  expect(chat.rightSidebarOpen).toBe(false);
  chat.onToggleRightSidebar();
  chat.onCloseWorkspace!();
  expect(editor().rightSidebarOpen).toBe(true);
});

test('sidebar handles follow chat sidebar visibility and leave review resizing to the review panel', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const handles = () => elements(app.render()).flatMap(element => {
    const attributes = element.props as HTMLAttributes<HTMLElement>;
    return attributes.role === 'separator' ? [attributes['aria-label']] : [];
  });
  const toggle = () => props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').onToggleRightSidebar();
  expect(handles()).toEqual(['Resize left sidebar', 'Resize right sidebar']);
  toggle();
  expect(handles()).toEqual(['Resize left sidebar']);
  toggle();
  expect(handles()).toEqual(['Resize left sidebar', 'Resize right sidebar']);
  props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor')
    .onShowLineCommit({ path: 'sample.ts', line: 1, content: 'sample' });
  expect(handles()).toEqual(['Resize left sidebar']);
  props<ComponentProps<typeof ReviewSidebar>>(app.render(), 'ReviewSidebar').onCloseReview();
  expect(handles()).toEqual(['Resize left sidebar', 'Resize right sidebar']);
});

test('line commits open in the shared sidebar, replace the requested line, and restore chats on close', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
  const review = () => props<ComponentProps<typeof ReviewSidebar>>(app.render(), 'ReviewSidebar');
  const chat = () => props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
  chat().onToggleRightSidebar();
  expect(review().open).toBe(false);
  const request = { path: 'first.ts', line: 1, content: 'draft\nsecond' };
  const editorTarget = editor().target;
  editor().onShowLineCommit(request);
  expect(review().lineCommit).toBe(request);
  expect(review().open).toBe(true);
  expect(editor().target).toBe(editorTarget);
  expect(split().mode).toBe('split');
  expect(chat().sessionSyncEnabled).toBe(false);
  const next = { ...request, line: 2 };
  editor().onShowLineCommit(next);
  expect(review().lineCommit).toBe(next);
  chat().onToggleRightSidebar();
  expect(review().open).toBe(false);
  expect(review().lineCommit).toBe(next);
  chat().onToggleRightSidebar();
  expect(review().open).toBe(true);
  review().onCloseReview();
  expect(review().lineCommit).toBeNull();
  expect(chat().sessionSyncEnabled).toBe(true);
  editor().onShowLineCommit(request);
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('git');
  expect(review().lineCommit).toBeNull();
});

for (const [view, component] of [['codegraph', 'CodeGraphView'], ['terminal', 'TerminalWorkspace']] as const) {
  test(`${view} workspace closes beside files and reopens through navigation`, () => {
    const app = shellHarness();
    const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    const page = () => props<ComponentProps<typeof CodeGraphView> | ComponentProps<typeof TerminalWorkspace>>(split().children, component);
    props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate(view);
    expect(page().onCloseWorkspace).toBeUndefined();
    props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
    expect(split().mode).toBe('split');
    page().onCloseWorkspace!();
    expect(split().mode).toBe('editor');
    const closedPage = page(); // The page component stays mounted; closing does not remove its controller.
    if ('active' in closedPage) expect(closedPage.active).toBe(false);
    const editor = props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
    expect(editor.active).toBe(true);
    expect(editor.target?.path).toBe('first.ts');
    expect(editor.onToggleRightSidebar).toBeDefined();
    props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate(view);
    expect(split().mode).toBe('split');
    const reopenedPage = page();
    if ('active' in reopenedPage) expect(reopenedPage.active).toBe(true);
    expect(reopenedPage.onCloseWorkspace).toBeDefined();
    props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').onAllTabsClosed();
    expect(split().mode).toBe('primary');
    expect(page().onCloseWorkspace).toBeUndefined();
  });
}

for (const view of ['git', 'plugins', 'showcase'] as const) {
  test(`${view} uses the full workspace while retaining file tabs for other pages`, () => {
    const app = shellHarness();
    const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
    const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
    sidebar().onOpenWorkspaceFile('draft.ts');
    const target = editor().target;
    editor().onDirtyPathsChange?.(['draft.ts']);
    sidebar().onNavigate(view);
    expect(split().mode).toBe('page');
    expect(editor().active).toBe(false);
    expect(editor().target).toBe(target);
    expect(editor().onToggleRightSidebar).toBeUndefined();
    editor().onSessionRestored?.();
    expect(split().mode).toBe('page');
    for (const splitView of ['chat', 'codegraph', 'terminal'] as const) {
      sidebar().onNavigate(splitView);
      expect(split().mode).toBe('split');
      expect(editor().active).toBe(true);
      expect(editor().target).toBe(target);
      sidebar().onNavigate(view);
      expect(split().mode).toBe('page');
    }
    sidebar().onOpenWorkspaceFile('next.ts');
    expect(split().mode).toBe('editor');
    expect(editor().target?.path).toBe('next.ts');
    expect(editor().onToggleRightSidebar).toBeDefined();
    sidebar().onOpenWorkspaceFile('another.ts');
    expect(split().mode).toBe('editor');
    expect(editor().target?.path).toBe('another.ts');
    editor().onAllTabsClosed();
    expect(split().mode).toBe('primary');
    expect(sidebar().activeView).toBe(view);
    expect(editor().target).toBeNull();
    expect(editor().active).toBe(false);
  });
}

const appleNote: AppleNote = { id: 'note', title: 'Meeting', plaintext: 'Agenda', locked: false, modifiedAt: '2026-09-16T00:00:00Z' };

test('Notes uses a full page while preserving the mounted chat and attaches to its selected draft', async () => {
  const app = shellHarness();
  const imports: (File | string)[][] = [];
  app.attachments.register('chat-a', async files => { imports.push(files); return true; });
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('draft.ts');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('notes');
  const tree = app.render();
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit').mode).toBe('page');
  expect(props<ComponentProps<typeof ChatWorkspace>>(tree, 'ChatWorkspace').active).toBe(false);
  expect(await props<ComponentProps<typeof NotesView>>(tree, 'NotesView').onAttach(appleNote)).toBe(true);
  const file = imports[0]?.[0];
  expect(file).toBeInstanceOf(File);
  expect(await (file as File).text()).toBe('Agenda');
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
});

test('failed Notes attachment keeps the Notes page and late success does not override navigation', async () => {
  const app = shellHarness();
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('notes');
  expect(await props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView').onAttach(appleNote)).toBe(false);
  expect(props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView')).toBeDefined();
  let complete!: (value: boolean) => void;
  app.attachments.register('chat-a', () => new Promise<boolean>(resolve => { complete = resolve; }));
  const attaching = props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView').onAttach(appleNote);
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onNavigate('git');
  app.render();
  complete(true);
  expect(await attaching).toBe(true);
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activeView).toBe('git');
});
