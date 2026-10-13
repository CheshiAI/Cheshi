import * as layoutModel from '../frontend/src/features/shell/workspaceLayoutModel';
import * as splitModel from '../frontend/src/shared/ui/splitPaneModel';
import * as splitSizing from '../frontend/src/shared/ui/splitPaneSizing';
import { CHAT_PANE_MIN_WIDTH } from '../frontend/src/features/chat/chatWorkspaceModel';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { cloneElement, isValidElement, type ComponentProps, type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import type { AppShell } from '../frontend/src/features/shell/AppShell';
import type { WorkerWorkspace } from '../frontend/src/features/shell/WorkerWorkspace';
import type { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import type { SplitPaneLayout } from '../frontend/src/shared/ui/SplitPaneLayout';
import type { SlidingSidePanel } from '../frontend/src/shared/ui/SlidingSidePanel';
import type { Sidebar } from '../frontend/src/features/navigation/Sidebar';
import type { SidebarPanel } from '../frontend/src/features/navigation/sidebarPanel';
import { sidebarPanelForWorkspace } from '../frontend/src/features/navigation/sidebarPanel';
import type { useAppUpdateResume } from '../frontend/src/features/shell/useAppUpdateResume';
import type { SidebarRail } from '../frontend/src/features/navigation/SidebarRail';
import type { WorkspaceEditor } from '../frontend/src/features/editor/WorkspaceEditor';
import type { WorkspaceEditorPane } from '../frontend/src/features/editor/WorkspaceEditorPane';
import type { ChatWorkspace } from '../frontend/src/features/chat/ChatWorkspace';
import type { WorkspaceFileSearch } from '../frontend/src/features/navigation/WorkspaceFileSearch';
import type { CodeGraphView } from '../frontend/src/features/graph/CodeGraphView';
import * as draftAttachmentModule from '../frontend/src/features/chat/chatDraftAttachments';
import { appleNoteDraftText } from '../frontend/src/features/notes/appleNotesModel';
import type { NotesView } from '../frontend/src/features/notes/NotesView';
import type { GitWorkspace } from '../frontend/src/features/git/GitWorkspace';
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
      useImperativeHandle(ref: { current: unknown } | undefined, create: () => unknown) {
        if (ref) ref.current = create();
      },
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

function renderFilePane(loading: boolean, ready = true, existingFile = false) {
  const modules: Record<string, unknown> = {
    '../agent-chats/ChatsView': { ChatsView: 'ChatsView' },
    './AgentManagementViews': { AgentManagementViews: 'AgentManagementViews' },};
  for (const path of ['lucide-react', '../shell/WorkspaceLayoutControls', './editorFileDrop',
    '../../shared/file-icons/FileTypeIcon', '../../shared/ui', '../../shared/ui/TooltipButton',
    './WorkspaceEditorFileToolbar', './WorkspaceCodeExplanationMenu', './WorkspaceCodeExplanationToast',
    './WorkspaceEditorAssistPanel', './WorkspaceEditorSearchPanel', './WorkspaceProblemsPanel',
    './WorkspaceProblemsResizer', './workspaceEditorModel', '../navigation/ExplorerView']) {
    modules[path] = new Proxy({}, { get: (_target, name) => String(name) });
  }
  modules.react = { useContext: () => true };
  modules['./workspaceProblemsLayout'] = { useWorkspaceProblemsLayout: () => ({ stageRef: null }) };
  modules['./useWorkspaceEditorController'] = { useWorkspaceEditorController: () => ({
    loading, tabs: [], codeExplanation: {},
    currentFile: existingFile ? { path: 'preview.png', fileKind: 'image' } : null,
    activeTab: existingFile ? { previewDataUrl: 'data:image/png;base64,test' } : null,
  }) };
  const Pane = load<typeof WorkspaceEditorPane>('features/editor/WorkspaceEditorPane.tsx', 'WorkspaceEditorPane', modules);
  return Pane({ active: true, pane: { id: 'editor-main', ready, store: {} } } as ComponentProps<typeof WorkspaceEditorPane>);
}

test('file pane shows shared loading instead of the empty prompt during opening and session recovery', () => {
  for (const [loading, ready, label] of [[true, true, 'Opening file…'], [false, false, 'Restoring files…']] as const) {
    const tree = renderFilePane(loading, ready);
    expect(props<{ label: string }>(tree, 'LoadingState').label).toBe(label);
    expect(elements(tree).some(node => node.type === 'ExplorerEmptyState')).toBe(false);
    expect(props<HTMLAttributes<HTMLElement>>(tree, 'main')['aria-busy']).toBe(true);
  }
  const idle = renderFilePane(false);
  expect(elements(idle).some(node => node.type === 'ExplorerEmptyState')).toBe(true);
  expect(elements(idle).some(node => node.type === 'LoadingState')).toBe(false);
});

test('file pane retains the current preview while another file is opening', () => {
  const tree = renderFilePane(true, true, true);
  expect(props<{ label: string }>(tree, 'LoadingState').label).toBe('Opening file…');
  expect(props<{ alt: string }>(tree, 'img').alt).toBe('preview.png');
});

test('the empty Explorer header is replaced by the file tab header while pane controls stay available', () => {
  for (const existingFile of [false, true, false]) {
    const tree = renderFilePane(false, true, existingFile);
    expect(elements(tree).filter(node => node.type === 'ExplorerHeader')).toHaveLength(existingFile ? 0 : 1);
    expect(elements(tree).filter(node => node.type === 'TieredHeader')).toHaveLength(existingFile ? 1 : 0);
    const headerContent = existingFile
      ? props<{ primary: ReactNode }>(tree, 'TieredHeader').primary
      : props<{ actions: ReactNode }>(tree, 'ExplorerHeader').actions;
    expect(elements(headerContent).filter(node => node.type === 'FlatTabList')).toHaveLength(existingFile ? 1 : 0);
    expect(elements(headerContent).filter(node => node.type === 'WorkspaceLayoutControls')).toHaveLength(1);
    expect(props<{ 'aria-label': string }>(headerContent, 'TooltipButton')['aria-label']).toBe('Close all file tabs');
  }
});

function shellHarness(initialHistoryLoading = false, preference: { panel: SidebarPanel } = { panel: 'files' },
  initialLayout: splitModel.SplitLayoutNode | null = null) {
  const app = hooks();
  let historyLoading = initialHistoryLoading;
  let openSearch = () => {};
  let revealHomieRepository = () => {};
  let resumeOptions: Parameters<typeof useAppUpdateResume>[0];
  let editorSessionMode: ReturnType<typeof useAppUpdateResume>['editorSessionMode'] = 'restore';
  const attachments = draftAttachmentModule.createChatDraftAttachments();
  const modules: Record<string, unknown> = {
    '../agent-chats/ChatsView': { ChatsView: 'ChatsView' },
    './AgentManagementViews': { AgentManagementViews: 'AgentManagementViews' },
    './WorkerWorkspace': { WorkerWorkspace: 'WorkerWorkspace' },
    '../chat/FlashSourceLink': { FlashSourceNavigationContext: { Provider: 'FlashSourceNavigationContext' } },
    './workspaceLayoutModel': { ...layoutModel, readWorkspaceLayout: () => initialLayout, saveWorkspaceLayout() {} },
    '../chat/chatWorkspaceModel': { CHAT_PANE_MIN_WIDTH },
    '../../shared/ui/splitPaneModel': splitModel,
    react: app.react,
    '../navigation/sidebarPanel': {
      sidebarPanelForWorkspace,
      readSidebarPanel: () => preference.panel,
      saveSidebarPanel: (panel: SidebarPanel) => { preference.panel = panel; },
    },
    '../../cheshiDesktop': { cheshiDesktop: { agentRegistry: {
      onRepositoryReady(listener: () => void) { revealHomieRepository = listener; return () => { revealHomieRepository = () => {}; }; },
    } } },
    '../chat/chatDraftAttachments': { ...draftAttachmentModule, createChatDraftAttachments: () => attachments },
    '../notes/appleNotesModel': { appleNoteDraftText },
    '../chat/useChatWorkspace': { useChatWorkspace: () => ({ activePaneId: 'chat-a', controllers: {}, activeController: { state: { phase: 'ready' } }, relay: { running: false },
      sessionHistory: { loading: historyLoading, sessions: [] }, responseThreadIds: [], accountSwitchPending: false }) },
    '../chat/useChatHistorySearch': { useChatHistorySearch: () => ({ clear() {} }) },
    './useAppUpdateResume': { useAppUpdateResume: (options: typeof resumeOptions) => {
      resumeOptions = options;
      return { busy: editorSessionMode === 'waiting', error: null, editorSessionMode };
    } },
    './useWorkflowChatNavigation': { useWorkflowChatNavigation: () => async () => false },
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
    '../navigation/ExplorerView': ['ExplorerView'],
    '../terminal': ['TerminalWorkspace'],
    '../settings/SettingsView': ['SettingsView'],
    '../scheduler/SchedulerNotifications': ['SchedulerNotifications'],
    '../settings/DiscordSetupConfirmation': ['DiscordSetupConfirmation'],
    '../calendar/CalendarView': ['CalendarView'],
    './ReviewSidebar': ['ReviewSidebar'], './WorkspaceStatusBar': ['WorkspaceStatusBar'],
    '../editor/LocalHistoryPage': ['LocalHistoryPage'], './WorkspaceEditorSplit': ['WorkspaceEditorSplit'],
    '../navigation/WorkspaceFileSearch': ['WorkspaceFileSearch'], '../notes/NotesView': ['NotesView'],
  })) modules[path] = Object.fromEntries(names.map(name => [name, name]));
  modules['../../shared/ui'] = { RegionalBlur: 'RegionalBlur', LiquidGlassPanel: 'LiquidGlassPanel', SlidingSidePanel: 'SlidingSidePanel',
    SidebarToggleVisibility: { Provider: 'SidebarToggleVisibility' } };
  const worker = hooks();
  const Worker = load<typeof WorkerWorkspace>('features/shell/WorkerWorkspace.tsx', 'WorkerWorkspace', {
    react: worker.react, '../agent-chats/ChatsView': { ChatsView: 'ChatsView' },
    './AgentManagementViews': { AgentManagementViews: 'AgentManagementViews' },
  });
  const expandWorker = (node: ReactNode): ReactNode => {
    if (Array.isArray(node)) return node.map(expandWorker);
    if (!isValidElement<{ children?: ReactNode }>(node)) return node;
    if (node.type === 'WorkerWorkspace') return worker.render(() => Worker(node.props as ComponentProps<typeof WorkerWorkspace>));
    return cloneElement(node, { children: expandWorker(node.props.children) });
  };
  const Shell = load<typeof AppShell>('features/shell/AppShell.tsx', 'AppShell', modules, { document: {} });
  return { attachments, render: () => {
    app.render(() => Shell());
    return expandWorker(app.render(() => Shell()));
  }, openSearch: () => openSearch(), revealHomieRepository: () => revealHomieRepository(),
    beginRestore: () => { editorSessionMode = 'waiting'; },
    restoreShell: (view: Parameters<typeof resumeOptions.setActiveView>[0], panel: SidebarPanel) => {
      resumeOptions.setActiveView(view);
      resumeOptions.setSidebarPanel(panel);
    },
    finishRestore: () => { editorSessionMode = 'preserve'; },
    finishOrdinaryStartup: () => { editorSessionMode = 'restore'; },
    finishInitialHistory: () => { historyLoading = false; } };
}

test('Worker keeps the conversation beside Homie settings and reserves the central editor for creation', () => {
  const app = shellHarness();
  const chats = () => props<ComponentProps<typeof ChatsView>>(app.render(), 'ChatsView');
  const management = () => props<ComponentProps<typeof AgentManagementViews>>(app.render(), 'AgentManagementViews');
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chats');
  expect(chats().active).toBe(true);
  expect(management().view).toBeNull();
  chats().onManageHomies?.();
  expect(chats().active).toBe(true);
  expect(chats().sidebarActive).toBe(true);
  expect(chats().homiesOpen).toBe(true);
  expect(management()).toMatchObject({ view: 'homies', selectionRequest: { agentId: null } });
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(props<ComponentProps<typeof AgentManagementViews>>(split.children, 'AgentManagementViews').view).toBe('homies');
  expect(props<{ value: boolean }>(app.render(), 'SidebarToggleVisibility').value).toBe(false);
  expect(props<ComponentProps<typeof ReviewSidebar>>(app.render(), 'ReviewSidebar').item).toBeNull();
  management().onEditingChange?.(true);
  expect(chats().active).toBe(false);
  management().onEditingChange?.(false);
  expect(chats().active).toBe(true);
  management().onClose?.();
  expect(chats().active).toBe(true);
  expect(chats().homiesOpen).toBe(false);
  expect(management().view).toBe('homies');
  chats().onManageHomies?.();
  expect(chats().homiesOpen).toBe(true);
  chats().onManageHomies?.();
  expect(chats().homiesOpen).toBe(false);
  chats().onManageHomies?.('development');
  expect(chats().active).toBe(true);
  expect(chats().homiesOpen).toBe(true);
  expect(management().selectionRequest).toEqual({ agentId: 'development' });
  chats().onOpenRoom?.();
  expect(chats().active).toBe(true);
  expect(management().view).toBeNull();
});

test('successful Homie repository preparation reveals Explorer while retaining the Worker view', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chats');
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('agent-chats');
  app.revealHomieRepository();
  const tree = app.render();
  expect(props<ComponentProps<typeof Sidebar>>(tree, 'Sidebar').activePanel).toBe('files');
  expect(props<ComponentProps<typeof ChatsView>>(tree, 'ChatsView').active).toBe(true);
  expect(elements(tree).find(node => (node.props as { id?: string }).id === 'workspace-sidebar')?.props)
    .toMatchObject({ open: true });
});

test('sidebar tabs retain navigation and load initial chats before limiting refresh to Sessions', () => {
  const app = shellHarness(true);
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const chat = () => props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace');
  expect(sidebar().activePanel).toBe('files');
  expect(chat().sessionSyncEnabled).toBe(true);
  expect(sidebar().chatPanel).toBeDefined();
  expect(props<{ value: boolean }>(app.render(), 'SidebarToggleVisibility').value).toBe(false);
  sidebar().onPanelChange!('files');
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

test('shell saves manual tab selections but opens Explorer on ordinary startup', () => {
  const preference: { panel: SidebarPanel } = { panel: 'chats' };
  const app = shellHarness(false, preference);
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('files');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onPanelChange!('memos');
  app.render();
  expect(preference.panel).toBe('memos');
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('memos');
  expect(props<ComponentProps<typeof Sidebar>>(shellHarness(false, preference).render(), 'Sidebar').activePanel).toBe('files');
});

test.each(['editor', 'split'] as const)('saved %s layouts open the explorer before restoring editor files', mode => {
  const app = shellHarness(false, { panel: 'memos' }, layoutModel.visibleWorkspaceLayout(mode, false));
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('files');
});

test('ordinary startup keeps Explorer after the update snapshot check finishes', () => {
  const app = shellHarness();
  app.beginRestore();
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('files');
  app.finishOrdinaryStartup();
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('files');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  rail().onNavigate('chat');
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('chats');
});

test('Explorer startup opens files in the editor and returns to its empty page after the last tab closes', () => {
  const app = shellHarness();
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(rail().activeView).toBe('explorer');
  expect(elements(split().children).some(node => node.type === 'ExplorerView')).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').active).toBe(false);
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('draft.ts');
  expect(split().mode).toBe('editor');
  expect(rail().activeView).toBe('editor');
  const editor = props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
  expect(editor.target?.path).toBe('draft.ts');
  editor.onAllTabsClosed();
  expect(rail().activeView).toBe('explorer');
  expect(elements(split().children).some(node => node.type === 'ExplorerView')).toBe(true);
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').target).toBeNull();
});

test('opening Explorer from the split chooser without files retains the chat and uses the empty pane', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  split().onLayoutChange!(layoutModel.placeWorkspacePane({ type: 'pane', paneId: 'primary' }, 'primary', 'editor', 'right'));
  split().onOpenPane!('editor');
  const editor = props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
  expect(editor.active).toBe(true);
  expect(editor.target).toBeNull();
  expect(props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').active).toBe(true);
  const empty = renderFilePane(false);
  expect(elements(empty).some(node => node.type === 'ExplorerHeader')).toBe(true);
  expect(elements(empty).some(node => node.type === 'ExplorerEmptyState')).toBe(true);
  expect(elements(empty).some(node => node.type === 'TieredHeader')).toBe(false);
});

test.each(['primary', 'terminal-left', 'terminal-below'] as const)(
  'Explorer replaces its empty area when opening or restoring files with a saved %s layout', name => {
    const initial: splitModel.SplitLayoutNode = name === 'primary' ? { type: 'pane', paneId: 'primary' } : {
      type: 'split', id: 'saved-layout', axis: name === 'terminal-left' ? 'columns' : 'rows', ratio: .63,
      first: { type: 'pane', paneId: name === 'terminal-left' ? 'terminal' : 'primary' },
      second: { type: 'pane', paneId: name === 'terminal-left' ? 'primary' : 'terminal' },
    };
    for (const restore of [false, true]) {
      const app = shellHarness(false, { panel: 'files' }, initial);
      const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
      const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
      const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
      if (restore) editor().onSessionRestored!();
      else sidebar().onOpenWorkspaceFile('first.ts');
      const openedLayout = split().layout!;
      expect(splitModel.splitPaneIds(openedLayout).sort()).toEqual(name === 'primary' ? ['editor'] : ['editor', 'terminal']);
      expect(editor().active).toBe(true);
      expect(elements(split().children).some(node => node.type === 'ExplorerView')).toBe(false);
      if (initial.type === 'split') {
        expect(openedLayout).toMatchObject({ id: initial.id, axis: initial.axis, ratio: initial.ratio });
        if (openedLayout.type !== 'split') throw new Error('Terminal split was removed.');
        expect(name === 'terminal-left' ? openedLayout.first : openedLayout.second)
          .toBe(name === 'terminal-left' ? initial.first : initial.second);
      }
      sidebar().onOpenWorkspaceFile('second.ts');
      expect(split().layout).toBe(openedLayout);
      expect(editor().target?.path).toBe('second.ts');
      editor().onAllTabsClosed();
      expect(split().layout).toEqual(initial);
      expect(elements(split().children).some(node => node.type === 'ExplorerView')).toBe(true);
      expect(props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').activeView).toBe('explorer');
      sidebar().onOpenWorkspaceFile('reopened.ts');
      expect(split().layout).toEqual(openedLayout);
    }
  },
);

test('opening a file removes a duplicate empty Explorer area and reuses an existing editor', () => {
  const app = shellHarness();
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  split().onLayoutChange!({ type: 'split', id: 'duplicate-explorer', axis: 'columns', ratio: .5,
    first: { type: 'pane', paneId: 'primary' }, second: { type: 'pane', paneId: 'editor' } });
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('file.ts');
  expect(split().layout).toEqual({ type: 'pane', paneId: 'editor' });
  expect(elements(split().children).some(node => node.type === 'ExplorerView')).toBe(false);
});

test.each([false, true])('split pane focus owns rail selection without replacing the scene (custom layout: %s)', custom => {
  const savedLayout = custom ? layoutModel.visibleWorkspaceLayout('split', false, .37) : null;
  const app = shellHarness(false, { panel: 'files' }, savedLayout);
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  rail().onNavigate('chat');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onPanelChange!('files');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('unsaved.ts');
  const target = props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').target;
  expect(rail().activeView).toBe('editor');
  expect(props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').active).toBe(true);
  split().onPaneActivate!('primary');
  expect(rail().activeView).toBe('chat');
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('files');
  split().onPaneActivate!('editor');
  expect(rail().activeView).toBe('editor');
  rail().onNavigate('chat');
  expect(rail().activeView).toBe('chat');
  expect(split().focusRequest?.paneId).toBe('primary');
  rail().onToggleSidebar();
  rail().onNavigate('explorer');
  expect(rail().activeView).toBe('editor');
  expect(rail().sidebarOpen).toBe(true);
  expect(split().focusRequest?.paneId).toBe('editor');
  expect(split().layout).toBe(savedLayout);
  expect(split().mode).toBe('split');
  expect(props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace').active).toBe(true);
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor').target).toBe(target);
});

test.each(['chat', 'terminal', 'notes', 'git'] as const)(
  'Explorer rail opens its empty page from %s when no file is open', view => {
    const app = shellHarness();
    const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
    const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
    rail().onNavigate(view);
    sidebar().onPanelChange!('memos');
    expect(rail().activeView).toBe(view);
    rail().onNavigate('explorer');
    expect(sidebar().activePanel).toBe('files');
    expect(rail().activeView).toBe('explorer');
    expect(elements(app.render()).some(node => node.type === 'ExplorerView')).toBe(true);
    rail().onToggleSidebar();
    expect(rail().sidebarOpen).toBe(false);
    rail().onNavigate('explorer');
    expect(rail().sidebarOpen).toBe(true);
    expect(rail().activeView).toBe('explorer');
    expect(sidebar().activePanel).toBe('files');
    rail().onNavigate('explorer');
    expect(rail().sidebarOpen).toBe(true);
    expect(rail().activeView).toBe('explorer');
  },
);

test('sidebar follows opening, closing and restoring editor panes while preserving manual choices within a scene', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
  expect(sidebar().activePanel).toBe('chats');
  sidebar().onOpenWorkspaceFile('first.ts');
  expect(split().mode).toBe('split');
  expect(sidebar().activePanel).toBe('files');
  sidebar().onPanelChange!('memos');
  sidebar().onOpenWorkspaceFile('second.ts');
  expect(sidebar().activePanel).toBe('memos');
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('editor');
  expect(split().mode).toBe('editor');
  expect(sidebar().activePanel).toBe('files');
  sidebar().onPanelChange!('chats');
  editor().onDirtyPathsChange?.(['second.ts']);
  expect(sidebar().activePanel).toBe('chats');
  editor().onAllTabsClosed();
  expect(sidebar().activePanel).toBe('chats');
  editor().onSessionRestored?.();
  expect(sidebar().activePanel).toBe('files');
});

test.each(['chat', 'editor'] as const)('update recovery resolves the %s scene before overriding a saved manual tab', view => {
  const app = shellHarness();
  app.beginRestore();
  app.render();
  app.restoreShell(view, 'memos');
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe('memos');
  app.finishRestore();
  expect(props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').activePanel).toBe(view === 'chat' ? 'chats' : 'files');
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
  expect(railControl.activeView).toBe('explorer');
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
  expect(props<ComponentProps<typeof GitWorkspace>>(split.children, 'GitWorkspace').active).toBe(false);
});

test('Explorer file opening keeps the chat visible and reuses the same editor for subsequent files', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  let tree = app.render();
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit').mode).toBe('primary');
  props<ComponentProps<typeof Sidebar>>(tree, 'Sidebar').onOpenWorkspaceFile('first.ts');
  tree = app.render();
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit');
  expect(split.mode).toBe('split');
  expect(split.minimumPrimaryWidth).toBe(475);
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
  expect(closed.minimumPrimaryWidth).toBeUndefined();
  expect(elements(closed.children).some(element => element.type === 'GitWorkspace')).toBe(true);
  expect(props<ComponentProps<typeof WorkspaceEditor>>(closed.editor, 'WorkspaceEditor')).toMatchObject({ active: false, target: null });
});

test.each([
  { minimumPaneWidth: undefined, pointerX: 700.5, expected: 0.7 },
  { minimumPaneWidth: 475, pointerX: 900.5, expected: 0.525 },
  { minimumPaneWidth: 475, pointerX: 100.5, expected: 0.475 },
  { minimumPaneWidth: (id: string) => id === 'primary' ? 475 : 120, pointerX: 900.5, expected: 0.525 },
  { minimumPaneWidth: (id: string) => id === 'primary' ? 475 : 120, pointerX: 100.5, expected: 0.12 },
])('the shared separator respects $minimumPaneWidth minimum width and commits $expected on release', ({ minimumPaneWidth, pointerX, expected }) => {
  const app = hooks();
  const Layout = load<typeof SplitPaneLayout>('shared/ui/SplitPaneLayout.tsx', 'SplitPaneLayout', { react: app.react, './splitPaneSizing': splitSizing });
  const committed: number[] = [];
  const options: ComponentProps<typeof SplitPaneLayout> = {
    minimumPaneWidth,
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
  separator(render()).onPointerMove?.(pointer(pointerX));
  expect((render().props as { style: CSSProperties }).style.gridTemplateColumns).toContain(`${expected * 100}fr`);
  expect(committed).toEqual([]);
  separator(render()).onPointerUp?.(pointer(pointerX));
  expect(committed).toEqual([expected]);
  expect(captured).toBe(false);
});


test('restored file sessions reveal the editor from the Explorer startup page', () => {
  const app = shellHarness();
  const split = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor').onSessionRestored?.();
  const restored = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(restored.mode).toBe('editor');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(restored.editor, 'WorkspaceEditor').active).toBe(true);
  expect(props<ComponentProps<typeof ChatWorkspace>>(restored.children, 'ChatWorkspace').active).toBe(false);
});

test('closing Codex keeps file tabs and sidebar controls, and navigation restores the split', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
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
  resumed.onCloseWorkspace!();
  props<ComponentProps<typeof WorkspaceEditor>>(reopened.editor, 'WorkspaceEditor').onAllTabsClosed();
  const empty = props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  expect(empty.mode).toBe('primary');
  expect(props<ComponentProps<typeof ChatWorkspace>>(empty.children, 'ChatWorkspace')).toMatchObject({
    active: true, onCloseWorkspace: undefined,
  });
});

test('collapsed split keeps both panes mounted while hiding the separator and restores its ratio on reopening', () => {
  const app = hooks();
  const Layout = load<typeof SplitPaneLayout>('shared/ui/SplitPaneLayout.tsx', 'SplitPaneLayout', { react: app.react, './splitPaneSizing': splitSizing });
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
  expect(reopenedAttrs[0]!.style?.gridTemplateColumns).toContain('70fr');
  expect(reopenedAttrs.find(node => node.role === 'separator')?.hidden).toBe(false);
});

test('only the standalone editor controls the shared right sidebar and preserves its state on reopening Codex', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
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
  expect(props<ComponentProps<typeof ReviewSidebar>>(app.render(), 'ReviewSidebar').open).toBe(false);
  chat.onCloseWorkspace!();
  expect(editor().rightSidebarOpen).toBe(false);
  editor().onToggleRightSidebar!();
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
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  const split = () => props<ComponentProps<typeof WorkspaceEditorSplit>>(app.render(), 'WorkspaceEditorSplit');
  const editor = () => props<ComponentProps<typeof WorkspaceEditor>>(split().editor, 'WorkspaceEditor');
  const review = () => props<ComponentProps<typeof ReviewSidebar>>(app.render(), 'ReviewSidebar');
  const chat = () => props<ComponentProps<typeof ChatWorkspace>>(split().children, 'ChatWorkspace');
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('first.ts');
  expect(review().lineCommit).toBeNull();
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

test('GitHub rail and sidebar tab share the changes panel and preserve the mounted workspace across scenes', () => {
  const app = shellHarness();
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  const git = () => props<ComponentProps<typeof GitWorkspace>>(app.render(), 'GitWorkspace');
  expect(git().active).toBe(false);
  rail().onToggleSidebar();
  rail().onNavigate('git');
  expect(rail().sidebarOpen).toBe(true);
  expect(sidebar().activePanel).toBe('github');
  expect(git().active).toBe(true);
  const target = {} as HTMLDivElement;
  const attach = sidebar().githubPanelRef;
  if (typeof attach !== 'function') throw new Error('Expected GitHub panel callback ref');
  attach(target);
  expect(git().sidebarTarget).toBe(target);
  rail().onNavigate('chat');
  expect(git().active).toBe(false);
  expect(git().sidebarTarget).toBe(target);
  sidebar().onPanelChange!('github');
  expect(git().active).toBe(true);
  expect(sidebar().activePanel).toBe('github');
  sidebar().onPanelChange!('memos');
  expect(sidebar().activePanel).toBe('memos');
  git().onOpenChanges?.();
  expect(sidebar().activePanel).toBe('github');
  expect(sidebarPanelForWorkspace('git', ['primary', 'editor'])).toBe('github');
  expect(sidebarPanelForWorkspace('git', ['editor'])).toBe('files');
});

test('Memo tab browses alongside the current scene and opening a note activates the Memo page', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const notes = () => props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView');
  expect(notes().active).toBe(false);
  sidebar().onPanelChange!('memos');
  expect(sidebar().activePanel).toBe('memos');
  expect(notes().active).toBe(false);
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
  notes().onOpen!();
  expect(notes().active).toBe(true);
  expect(sidebar().activePanel).toBe('memos');
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
  expect(notes().active).toBe(false);
  expect(sidebar().activePanel).toBe('chats');
});

test('Notes uses a full page while preserving the mounted chat and adds text to its selected draft', async () => {
  const app = shellHarness();
  const imports: (File | string)[][] = [];
  const texts: string[] = [];
  app.attachments.register('chat-a', async files => { imports.push(files); return true; }, text => { texts.push(text); return true; });
  props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar').onOpenWorkspaceFile('draft.ts');
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('notes');
  const tree = app.render();
  expect(props<ComponentProps<typeof Sidebar>>(tree, 'Sidebar').activePanel).toBe('memos');
  expect(props<ComponentProps<typeof WorkspaceEditorSplit>>(tree, 'WorkspaceEditorSplit').mode).toBe('page');
  expect(props<ComponentProps<typeof ChatWorkspace>>(tree, 'ChatWorkspace').active).toBe(false);
  expect(await props<ComponentProps<typeof NotesView>>(tree, 'NotesView').onAttach(appleNote)).toBe(true);
  expect(texts).toEqual(['Agenda']);
  expect(imports).toEqual([]);
  expect(props<ComponentProps<typeof ChatWorkspace>>(app.render(), 'ChatWorkspace').active).toBe(true);
});

test('failed Notes attachment keeps the Notes page and late success does not override navigation', async () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('notes');
  expect(await props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView').onAttach(appleNote)).toBe(false);
  expect(props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView')).toBeDefined();
  let complete!: (value: boolean) => void;
  app.attachments.register('chat-a', async () => false, () => new Promise<boolean>(resolve => { complete = resolve; }));
  const attaching = props<ComponentProps<typeof NotesView>>(app.render(), 'NotesView').onAttach(appleNote);
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('git');
  app.render();
  complete(true);
  expect(await attaching).toBe(true);
  expect(props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').activeView).toBe('git');
});

test('custom workspace layout keeps editor, chat and terminal visible together and closing only hides the chosen area', () => {
  const app = shellHarness();
  props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail').onNavigate('chat');
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

test('Chats tab opens the conversation and rail navigation restores its sidebar without losing the list target', () => {
  const app = shellHarness();
  const sidebar = () => props<ComponentProps<typeof Sidebar>>(app.render(), 'Sidebar');
  const rail = () => props<ComponentProps<typeof SidebarRail>>(app.render(), 'SidebarRail');
  sidebar().onPanelChange!('agent-chats');
  expect(sidebar().activePanel).toBe('agent-chats');
  expect(props<{ active: boolean }>(app.render(), 'ChatsView').active).toBe(true);
  const target = {} as HTMLDivElement;
  (sidebar().chatsPanelRef as (node: HTMLDivElement) => void)(target);
  expect(props<{ sidebarTarget: HTMLDivElement }>(app.render(), 'ChatsView').sidebarTarget).toBe(target);
  sidebar().onPanelChange!('files'); rail().onToggleSidebar();
  rail().onNavigate('chats');
  expect(sidebar().activePanel).toBe('agent-chats'); expect(rail().sidebarOpen).toBe(true);
  expect(props<{ sidebarTarget: HTMLDivElement }>(app.render(), 'ChatsView').sidebarTarget).toBe(target);
});
