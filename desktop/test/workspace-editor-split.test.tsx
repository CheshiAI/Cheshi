import * as layoutModel from '../frontend/src/features/shell/workspaceLayoutModel';
import * as splitModel from '../frontend/src/shared/ui/splitPaneModel';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isValidElement, type ComponentProps, type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import type { AppShell } from '../frontend/src/features/shell/AppShell';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import type { SplitPaneLayout } from '../frontend/src/shared/ui/SplitPaneLayout';
import type { SlidingSidePanel } from '../frontend/src/shared/ui/SlidingSidePanel';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { SidebarPanel } from '../frontend/src/features/navigation/sidebarPanel';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
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

function shellHarness(initialHistoryLoading = false, preference: { panel: SidebarPanel } = { panel: 'files' }) {
  const app = hooks();
  let historyLoading = initialHistoryLoading;
  let openSearch = () => {};
  const attachments = draftAttachmentModule.createChatDraftAttachments();
  const modules: Record<string, unknown> = {
    './workspaceLayoutModel': { ...layoutModel, readWorkspaceLayout: () => null, saveWorkspaceLayout() {} },
    '../../shared/ui/splitPaneModel': splitModel,
    react: app.react,
    '../navigation/sidebarPanel': {
      readSidebarPanel: () => preference.panel,
      saveSidebarPanel: (panel: SidebarPanel) => { preference.panel = panel; },
    },
    '../chat/HistoryRecallActivity': { HistoryRecallNavigation: { Provider: 'HistoryRecallNavigation' } },
    '../chat/chatDraftAttachments': { ...draftAttachmentModule, createChatDraftAttachments: () => attachments },
    '../notes/appleNotesModel': { appleNoteAttachment },
    '../chat/useChatWorkspace': { useChatWorkspace: () => ({ activePaneId: 'chat-a', controllers: {}, activeController: { state: { phase: 'ready' } }, relay: { running: false },
      sessionHistory: { loading: historyLoading, sessions: [] }, responseThreadIds: [], accountSwitchPending: false }) },
    '../chat/useChatHistorySearch': { useChatHistorySearch: () => ({ clear() {} }) },
    './useAppUpdateResume': { useAppUpdateResume: () => ({ busy: false, error: null }) },
    '../navigation/fileSearchShortcut': { installFileSearchShortcut: (_document: unknown, open: () => void) => {
      openSearch = open; return () => {};
    } },
  };
  for (const [path, names] of Object.entries({
    '../../shared/ui': ['LiquidGlassPanel', 'SlidingSidePanel'], '../chat': ['ChatSessionList'], '../chat/ChatWorkspace': ['ChatWorkspace'],
    '../chat/TemporaryChatPanel': ['TemporaryChatPanel'], '../chat/ChatDeleteSessionDialog': ['ChatDeleteSessionDialog'],
    '../chat/ChatHistoryOpenDialog': ['ChatHistoryOpenDialog'], '../chat/ChatHistorySearchBar': ['ChatHistorySearchBar'],
    '../chat/ChatHistorySearchPage': ['ChatHistorySearchPage'], '../chrome/WindowChrome': ['WindowChrome', 'WindowTabs'],
    '../editor': ['WorkspaceEditor'], '../git': ['GitWorkspace'], '../graph': ['CodeGraphView'],
    '../home/BlankView': ['BlankView'], '../navigation/Sidebar': ['Sidebar'], '../navigation/SidebarRail': ['SidebarRail'],
    '../plugins': ['PluginsView'],
    '../terminal': ['TerminalWorkspace'],
    '../settings/SettingsView': ['SettingsView'],
    '../mail/MailView': ['MailView'], '../calendar/CalendarView': ['CalendarView'],
    './ReviewSidebar': ['ReviewSidebar'], './WorkspaceStatusBar': ['WorkspaceStatusBar'],
    '../editor/LocalHistoryPage': ['LocalHistoryPage'], './WorkspaceEditorSplit': ['WorkspaceEditorSplit'],
    '../navigation/WorkspaceFileSearch': ['WorkspaceFileSearch'], '../notes/NotesView': ['NotesView'],
  })) modules[path] = Object.fromEntries(names.map(name => [name, name]));
  modules['../../shared/ui'] = { LiquidGlassPanel: 'LiquidGlassPanel', SlidingSidePanel: 'SlidingSidePanel',
    SidebarToggleVisibility: { Provider: 'SidebarToggleVisibility' } };
  const Shell = load<typeof AppShell>('features/shell/AppShell.tsx', 'AppShell', modules, { document: {} });
  return { attachments, render: () => app.render(() => Shell()), openSearch: () => openSearch(),
    finishInitialHistory: () => { historyLoading = false; } };
}

test('sidebar tabs retain navigation and load initial chats before limiting refresh to Sessions', () => {
  const app = shellHarness(true);
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const chat = () => props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace');
  expect(sidebar().activePanel).toBe('files');
  expect(chat().sessionSyncEnabled).toBe(true);
  expect(sidebar().chatPanel).toBeDefined();
  expect(props<{ value: boolean }>(app.render(), 'SidebarToggleVisibility').value).toBe(false);
  app.finishInitialHistory();
  expect(chat().sessionSyncEnabled).toBe(false);
  sidebar().onPanelChange!('chats');
  expect(sidebar().activePanel).toBe('chats');
  expect(chat().sessionSyncEnabled).toBe(true);
  rail().onNavigate('settings');
  expect(sidebar().activePanel).toBe('chats');
  expect(elements(app.render()).some(element => element.type === 'SettingsView')).toBe(true);
  sidebar().onPanelChange!('files');
  expect(chat().sessionSyncEnabled).toBe(false);
  sidebar().onPanelChange!('memos');
  expect(sidebar().activePanel).toBe('memos');
  expect(chat().sessionSyncEnabled).toBe(false);
});

test('shell saves and restores the last selected sidebar tab', () => {
  const preference: { panel: SidebarPanel } = { panel: 'chats' };
  const app = shellHarness(false, preference);
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('chats');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onPanelChange!('memos');
  app.render();
  expect(preference.panel).toBe('memos');
  expect(props<ComponentProps<typeof Sidebar>>(shellHarness(false, preference).render(), 'Sidebar').activePanel).toBe('memos');
});

test('the fixed navigation rail precedes the left sidebar', () => {
  const tree = shellHarness().render();
  const panels = elements(tree).filter(element => element.type === 'LiquidGlassPanel');
  const rail = panels[0]?.props as HTMLAttributes<HTMLElement> | undefined;
  const sidebar = props<ComponentProps<typeof SlidingSidePanel>>(tree, 'SlidingSidePanel');
  expect(rail?.className).toBe('sidebarRail');
  expect(rail?.['aria-label']).toBe('Application navigation');
  expect(sidebar.className).toBe('sidebar-column sidebarPanel');
  expect(sidebar.stageClassName).toBe('sidebarPanelStage');
  expect(sidebar.anchor).toBe('end');
  expect(sidebar.open).toBe(true);
  const railControl = props<ComponentProps<typeof SidebarRail>>(rail?.children, 'SidebarRail');
  expect(railControl.activeView).toBe('chat');
  expect(railControl.sidebarOpen).toBe(true);
});

test('the rail control collapses and restores the left sidebar', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onToggleSidebar();
  let tree = app.render();
  let panel = props<ComponentProps<typeof SlidingSidePanel>>(tree, 'SlidingSidePanel');
  expect(panel).toMatchObject({ open: false, id: 'workspace-sidebar' });
  expect(elements(panel.children).some(element => element.type === 'Sidebar')).toBe(true);
  const resizer = elements(tree).find(element => (element.props as HTMLAttributes<HTMLElement>)['aria-label'] === 'Resize left sidebar');
  expect(resizer).toBeUndefined();
  const rail = props<ComponentProps<typeof SidebarRail>>(tree, 'SidebarRail');
  expect(rail.sidebarOpen).toBe(false);
  rail.onToggleSidebar();
  tree = app.render();
  panel = props<ComponentProps<typeof SlidingSidePanel>>(tree, 'SlidingSidePanel');
  expect(panel.open).toBe(true);
  expect(props<ComponentProps<typeof SidebarRail>>(tree, 'SidebarRail').sidebarOpen).toBe(true);
});

test('file search keeps the current page until a result opens in the standalone editor', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('git');
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
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('git');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(split.mode).toBe('editor');
  props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor').onAllTabsClosed();
  const closed = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(closed.mode).toBe('primary');
  expect(elements(closed.children).some(element => element.type === 'GitWorkspace')).toBe(true);
  expect(props<ComponentProps<typeof WorkspaceEditor>>(closed.editor, 'WorkspaceEditor')).toMatchObject({ active: false, target: null });
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
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
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

test('collapsed split keeps both panes mounted while hiding the separator and restores its ratio on reopening', () => {
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
  expect(elements(tree).filter(node => node.type === Layout)).toHaveLength(2);
  const reopened = app.render(() => Component({ ...options, collapsedPane: null }));
  const reopenedAttrs = elements(reopened).map(node => node.props as HTMLAttributes<HTMLDivElement>);
  expect(reopenedAttrs[0]!.style?.gridTemplateColumns).toContain('0.7fr');
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
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  expect(split().mode).toBe('split');
  expect(editor().onToggleRightSidebar).toBeUndefined();
  const chat = props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace');
  expect(chat.rightSidebarOpen).toBe(false);
  chat.onToggleRightSidebar();
  chat.onCloseWorkspace!();
  expect(editor().rightSidebarOpen).toBe(true);
});

test('files and chats switch without shell resize handles while review controls stay in their panel', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const handles = () => elements(app.render()).flatMap(element => {
    const attributes = element.props as HTMLAttributes<HTMLElement>;
    return attributes.role === 'separator' ? [attributes['aria-label']] : [];
  });
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  expect(handles()).toEqual([]);
  sidebar().onPanelChange!('chats');
  expect(sidebar().activePanel).toBe('chats');
  expect(handles()).toEqual([]);
  sidebar().onPanelChange!('files');
  expect(sidebar().activePanel).toBe('files');
  expect(handles()).toEqual([]);
  props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor')
    .onShowLineCommit({ path: 'sample.ts', line: 1, content: 'sample' });
  expect(handles()).toEqual([]);
  props<ComponentProps<typeof ReviewSidebar>>(app.render(), 'ReviewSidebar').onCloseReview();
  expect(handles()).toEqual([]);
});

test('line commits remain independent of the selected left panel and keep chats available on close', () => {
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
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onPanelChange!('chats');
  expect(chat().sessionSyncEnabled).toBe(true);
  expect(props<{ value: boolean }>(app.render(), 'SidebarToggleVisibility').value).toBe(true);
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
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('chats');
  expect(props<{ value: boolean }>(app.render(), 'SidebarToggleVisibility').value).toBe(false);
  editor().onShowLineCommit(request);
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('git');
  expect(review().lineCommit).toBeNull();
});

for (const [view, component] of [['codegraph', 'CodeGraphView'], ['terminal', 'TerminalWorkspace']] as const) {
  test(`${view} workspace closes beside files and reopens through navigation`, () => {
    const app = shellHarness();
    const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    const page = () => props<ComponentProps<typeof CodeGraphView> | ComponentProps<typeof TerminalWorkspace>>(view === 'terminal' ? split().terminal : split().children, component);
    props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate(view);
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
    props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate(view);
    expect(split().mode).toBe('split');
    const reopenedPage = page();
    if ('active' in reopenedPage) expect(reopenedPage.active).toBe(true);
    expect(reopenedPage.onCloseWorkspace).toBeDefined();
    props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').onAllTabsClosed();
    expect(split().mode).toBe('primary');
    expect(page().onCloseWorkspace).toBeUndefined();
  });
}

for (const view of ['git', 'plugins'] as const) {
  test(`${view} uses the full workspace while retaining file tabs for other pages`, () => {
    const app = shellHarness();
    const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
    const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
    const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
    const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
    sidebar().onOpenWorkspaceFile('draft.ts');
    const target = editor().target;
    editor().onDirtyPathsChange?.(['draft.ts']);
    rail().onNavigate(view);
    expect(split().mode).toBe('page');
    expect(editor().active).toBe(false);
    expect(editor().target).toBe(target);
    expect(editor().onToggleRightSidebar).toBeUndefined();
    editor().onSessionRestored?.();
    expect(split().mode).toBe('page');
    for (const splitView of ['chat', 'codegraph', 'terminal'] as const) {
      rail().onNavigate(splitView);
      expect(split().mode).toBe('split');
      expect(editor().active).toBe(true);
      expect(editor().target).toBe(target);
      rail().onNavigate(view);
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
    expect(rail().activeView).toBe(view);
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
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('notes');
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
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('notes');
  expect(await props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView').onAttach(appleNote)).toBe(false);
  expect(props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView')).toBeDefined();
  let complete!: (value: boolean) => void;
  app.attachments.register('chat-a', () => new Promise<boolean>(resolve => { complete = resolve; }));
  const attaching = props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView').onAttach(appleNote);
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('git');
  app.render();
  complete(true);
  expect(await attaching).toBe(true);
  expect(props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').activeView).toBe('git');
});

test('custom workspace layout keeps editor, chat and terminal visible together and closing only hides the chosen area', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const layout = layoutModel.placeWorkspacePane(layoutModel.visibleWorkspaceLayout('split', false), 'workspace', 'terminal', 'down');
  split().onLayoutChange!(layout);
  split().onOpenPane!('terminal');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').active).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').active).toBe(true);
  expect(props<ComponentProps<typeof TerminalWorkspace>>(split().terminal, 'TerminalWorkspace').active).toBe(true);
  props<ComponentProps<typeof TerminalWorkspace>>(split().terminal, 'TerminalWorkspace').onCloseWorkspace!();
  expect(splitModel.splitPaneIds(split().layout!)).toEqual(['editor', 'primary']);
  expect(props<ComponentProps<typeof TerminalWorkspace>>(split().terminal, 'TerminalWorkspace').active).toBe(false);
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('terminal');
  expect(props<ComponentProps<typeof TerminalWorkspace>>(split().terminal, 'TerminalWorkspace').active).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').active).toBe(true);
});
