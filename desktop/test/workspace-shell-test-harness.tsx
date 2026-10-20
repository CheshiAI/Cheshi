import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as layoutModel from '../frontend/src/features/shell/workspaceLayoutModel';
import * as splitModel from '../frontend/src/shared/ui/splitPaneModel';
import { CHAT_PANE_MIN_WIDTH } from '../frontend/src/features/chat/chatWorkspaceModel';
import type { AppShell } from '../frontend/src/features/shell/AppShell';
import type { WorkerWorkspace } from '../frontend/src/features/shell/WorkerWorkspace';
import type { WorkspaceEditorSplit } from '../frontend/src/features/shell/WorkspaceEditorSplit';
import type { useAppUpdateResume } from '../frontend/src/features/shell/useAppUpdateResume';
import type { useToolsMenu } from '../frontend/src/features/shell/useToolsMenu';
import { sidebarPanelForWorkspace, type SidebarPanel } from '../frontend/src/features/navigation/sidebarPanel';
import * as draftAttachmentModule from '../frontend/src/features/chat/chatDraftAttachments';

export function hooks() {
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
      // This harness exercises hook transitions directly, outside React reconciliation.
      memo<T>(component: T): T { return component; },
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

export function load<T>(path: string, name: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
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

export function elements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node, ...elements(node.props.children), ...elements((node.props as { worker?: ReactNode }).worker)];
}

export function props<T>(tree: ReactNode, name: string): T {
  const node = elements(tree).find(element => element.type === name);
  if (!node) throw new Error(`Missing component: ${name}`);
  return node.props as T;
}

export function shellHarness(initialHistoryLoading = false, preference: { panel: SidebarPanel } = { panel: 'files' },
  initialLayout: splitModel.SplitLayoutNode | null = null) {
  const app = hooks();
  let historyLoading = initialHistoryLoading;
  let openSearch = () => {};
  let openTool: Parameters<typeof useToolsMenu>[0] = () => {};
  let revealHomieRepository = () => {};
  let resumeOptions: Parameters<typeof useAppUpdateResume>[0];
  let editorSessionMode: ReturnType<typeof useAppUpdateResume>['editorSessionMode'] = 'restore';
  const attachments = draftAttachmentModule.createChatDraftAttachments();
  const modules: Record<string, unknown> = {
    '../settings/useHomiesEnabled': { useHomiesEnabled: () => true },
    './WorkspaceSurfaceReporter': { WorkspaceSurfaceReporter: 'WorkspaceSurfaceReporter' },
    '../agent-chats/ChatsView': { ChatsView: 'ChatsView' },
    './AgentManagementViews': { AgentManagementViews: 'AgentManagementViews' },
    './WorkerWorkspace': { WorkerWorkspace: 'WorkerWorkspace' },
    '../chat/FlashSourceLink': { FlashSourceNavigationContext: { Provider: 'FlashSourceNavigationContext' } },
    './workspaceLayoutModel': { ...layoutModel, readWorkspaceLayout: () => initialLayout, saveWorkspaceLayout() {} },
    '../chat/chatWorkspaceModel': { CHAT_PANE_MIN_WIDTH },
    '../../shared/ui/splitPaneModel': splitModel,
    react: { ...app.react, lazy: () => 'CanvasView', Suspense: 'Suspense' },
    '../navigation/sidebarPanel': {
      sidebarPanelForWorkspace,
      readSidebarPanel: () => preference.panel,
      saveSidebarPanel: (panel: SidebarPanel) => { preference.panel = panel; },
    },
    '../../cheshiDesktop': { cheshiDesktop: { agentRegistry: {
      onRepositoryReady(listener: () => void) { revealHomieRepository = listener; return () => { revealHomieRepository = () => {}; }; },
    } } },
    '../chat/chatDraftAttachments': { ...draftAttachmentModule, createChatDraftAttachments: () => attachments },
    '../chat/useChatWorkspace': { useChatWorkspace: () => ({ activePaneId: 'chat-a', controllers: {}, dismissError() {}, activeController: { state: { phase: 'ready', sessions: [] } }, relay: { running: false },
      sessionHistory: { loading: historyLoading, sessions: [] }, responseThreadIds: [], accountSwitchPending: false }) },
    '../chat/useChatHistorySearch': { useChatHistorySearch: () => ({ clear() {} }) },
    './useAppUpdateResume': { useAppUpdateResume: (options: typeof resumeOptions) => {
      resumeOptions = options;
      return { busy: editorSessionMode === 'waiting', error: null, editorSessionMode };
    } },
    './useWorkflowChatNavigation': { useWorkflowChatNavigation: () => async () => false },
    './useToolsMenu': { useToolsMenu(navigate: typeof openTool) { openTool = navigate; } },
    '../graph/useCodeGraphIndex': { useCodeGraphIndex: () => ({ status: { state: 'ready' } }) },
    '../navigation/fileSearchShortcut': { installFileSearchShortcut: (_document: unknown, open: () => void) => {
      openSearch = open; return () => {};
    } },
  };
  for (const [path, names] of Object.entries({
    '../../shared/ui': ['LiquidGlassPanel', 'SlidingSidePanel'], '../chat': ['ChatSessionList'], '../chat/ChatWorkspace': ['ChatWorkspace'],
    '../chat/ChatDeleteSessionDialog': ['ChatDeleteSessionDialog'],
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
    '../canvas/CanvasEmptyState': ['CanvasLoadingState'],
    './ReviewSidebar': ['ReviewSidebar'], './WorkspaceStatusBar': ['WorkspaceStatusBar'],
    '../editor/LocalHistoryPage': ['LocalHistoryPage'], './WorkspaceEditorSplit': ['WorkspaceEditorSplit'],
    '../navigation/WorkspaceFileSearch': ['WorkspaceFileSearch'], '../sticky-notes/MemoSidebar': ['MemoSidebar'],
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
    if (node.type === 'WorkspaceEditorSplit') {
      const split = node as ReactElement<ComponentProps<typeof WorkspaceEditorSplit>>;
      return cloneElement(split, { children: expandWorker(split.props.children), worker: expandWorker(split.props.worker) });
    }
    return cloneElement(node, { children: expandWorker(node.props.children) });
  };
  const Shell = load<typeof AppShell>('features/shell/AppShell.tsx', 'AppShell', modules, { document: {}, window: {} });
  return { attachments, render: () => {
    app.render(() => Shell());
    return expandWorker(app.render(() => Shell()));
  }, openSearch: () => openSearch(), openTool: (view: Parameters<typeof openTool>[0]) => openTool(view),
    revealHomieRepository: () => revealHomieRepository(),
    beginRestore: () => { editorSessionMode = 'waiting'; },
    restoreShell: (view: Parameters<typeof resumeOptions.setActiveView>[0], panel: SidebarPanel) => {
      resumeOptions.setActiveView(view);
      resumeOptions.setSidebarPanel(panel);
    },
    finishRestore: () => { editorSessionMode = 'preserve'; },
    finishOrdinaryStartup: () => { editorSessionMode = 'restore'; },
    finishInitialHistory: () => { historyLoading = false; } };
}
