import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createChatDraftAttachments } from '../frontend/src/features/chat/chatDraftAttachments';
import { appleNoteAttachment } from '../frontend/src/features/notes/appleNotesModel';

interface TestElement {
  type: string;
  props: Record<string, unknown>;
  key?: string;
}

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isElement(value)) return [];
  return [value, ...elements(value.props.children),
    ...(value.type === 'WorkspaceEditorSplit' ? elements(value.props.editor) : [])];
}

function element(tree: unknown, type: string): TestElement {
  const found = elements(tree).find((item) => item.type === type);
  if (!found) throw new Error(`Missing rendered ${type}.`);
  return found;
}

function invoke(target: TestElement, name: string, ...args: unknown[]): void {
  const callback = target.props[name];
  if (typeof callback !== 'function') throw new Error(`Missing ${target.type}.${name}.`);
  callback(...args);
}

function workspaceColumn(tree: unknown): TestElement {
  const column = elements(tree).find((item) => item.props.className === 'workspace-column');
  if (!column) throw new Error('Missing workspace column.');
  return column;
}

function createHarness() {
  let cursor = 0;
  const slots: unknown[] = [];
  const jsx = (type: string, props: Record<string, unknown>, key?: string): TestElement => ({ type, props, key });
  const modules: Record<string, unknown> = {
    react: {
      useRef(current: unknown) { return slots[cursor++] ??= { current }; },
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value: unknown) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        }];
      },
      useCallback(callback: unknown) { return callback; },
      useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../shared/ui': {
      LiquidGlassPanel: 'LiquidGlassPanel',
      SidebarToggleVisibility: { Provider: 'SidebarToggleVisibility' },
    },
    '../chat': { ChatSessionList: 'ChatSessionList' },
    '../chat/HistoryRecallActivity': { HistoryRecallNavigation: { Provider: 'HistoryRecallNavigation' } },
    '../chat/ChatWorkspace': { ChatWorkspace: 'ChatWorkspace' },
    '../chat/chatDraftAttachments': {
      ChatDraftAttachmentsContext: { Provider: 'ChatDraftAttachmentsProvider' }, createChatDraftAttachments,
    },
    '../chat/TemporaryChatPanel': { TemporaryChatPanel: 'TemporaryChatPanel' },
    '../chat/ChatDeleteSessionDialog': { ChatDeleteSessionDialog: 'ChatDeleteSessionDialog' },
    '../chat/ChatHistoryOpenDialog': { ChatHistoryOpenDialog: 'ChatHistoryOpenDialog' },
    '../chat/ChatHistorySearchBar': { ChatHistorySearchBar: 'ChatHistorySearchBar' },
    '../chat/ChatHistorySearchPage': { ChatHistorySearchPage: 'ChatHistorySearchPage' },
    '../chat/useChatHistorySearch': { useChatHistorySearch: () => ({ result: null, loading: false, error: null }) },
    '../chat/useChatWorkspace': { useChatWorkspace: () => ({
      activePaneId: 'chat-pane', activeController: null, controllers: {},
      accountSwitchPending: false, sessionHistory: { loading: false, sessions: [] }, responseThreadIds: [],
    }) },
    '../chrome/WindowChrome': { WindowChrome: 'WindowChrome', WindowTabs: 'WindowTabs' },
    '../editor': { WorkspaceEditor: 'WorkspaceEditor' },
    '../editor/LocalHistoryPage': { LocalHistoryPage: 'LocalHistoryPage' },
    '../git': { GitWorkspace: 'GitWorkspace' },
    '../graph': { CodeGraphView: 'CodeGraphView' },
    '../home/BlankView': { BlankView: 'BlankView' },
    '../navigation/Sidebar': { Sidebar: 'Sidebar' },
    '../navigation/SidebarRail': { SidebarRail: 'SidebarRail' },
    '../navigation/WorkspaceFileSearch': { WorkspaceFileSearch: 'WorkspaceFileSearch' },
    '../navigation/fileSearchShortcut': { installFileSearchShortcut() { return () => {}; } },
    '../notes/NotesView': { NotesView: 'NotesView' },
    '../notes/appleNotesModel': { appleNoteAttachment },
    '../mail/MailView': { MailView: 'MailView' },
    '../calendar/CalendarView': { CalendarView: 'CalendarView' },
    '../plugins': { PluginsView: 'PluginsView' },
    '../terminal': { TerminalWorkspace: 'TerminalWorkspace' },
    '../settings/SettingsView': { SettingsView: 'SettingsView' },
    './ReviewSidebar': { ReviewSidebar: 'ReviewSidebar' },
    './useAppUpdateResume': { useAppUpdateResume: () => ({ busy: false, error: null }) },
    './useSidebarResize': { useSidebarResize: () => ({ layoutRef: { current: null }, style: {}, resizing: null,
      separatorProps: () => ({ role: 'separator' }) }) },
    './WorkspaceStatusBar': { WorkspaceStatusBar: 'WorkspaceStatusBar' },
    './WorkspaceEditorSplit': { WorkspaceEditorSplit: 'WorkspaceEditorSplit' },
    './AppShell.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/shell/AppShell.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected AppShell dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.AppShell;
  if (typeof component !== 'function') throw new Error('AppShell export is unavailable.');
  return { render(): unknown { cursor = 0; return component(); } };
}

test('explorer history opens the right panel with draft protection while preserving the active page', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'SidebarRail'), 'onNavigate', 'git');
  invoke(element(tree, 'WorkspaceEditor'), 'onDirtyPathsChange', ['src/dirty.ts']);
  tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'src/dirty.ts');
  tree = harness.render();
  expect(element(tree, 'SidebarRail').props.activeView).toBe('git');
  expect(element(tree, 'Sidebar').props.selectedFilePath).toBe('src/dirty.ts');
  const history = element(tree, 'ReviewSidebar');
  expect(history.props.localHistoryPath).toBe('src/dirty.ts');
  expect(history.props.localHistoryDirty).toBe(true);
  expect(history.props.open).toBe(true);
  expect(elements(workspaceColumn(tree)).some(item => item.type === 'LocalHistoryPage')).toBe(false);
  expect(element(tree, 'WorkspaceEditorSplit').props.mode).toBe('primary');
  const footer = element(tree, 'WorkspaceStatusBar');
  expect(Object.keys(footer.props).filter((name) => /history/i.test(name))).toEqual([]);
  invoke(history, 'onCloseReview');
  tree = harness.render();
  expect(element(tree, 'SidebarRail').props.activeView).toBe('git');
  expect(element(tree, 'WorkspaceEditorSplit').props.mode).toBe('primary');
  expect(elements(tree).some((item) => item.type === 'GitWorkspace')).toBe(true);
  expect(element(tree, 'ReviewSidebar').props.localHistoryPath).toBeNull();
});

test('closing history after switching files leaves the editor open and preserves its draft state', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'SidebarRail'), 'onNavigate', 'terminal');
  invoke(element(tree, 'Sidebar'), 'onOpenWorkspaceFile', 'src/dirty.ts');
  invoke(element(tree, 'WorkspaceEditor'), 'onDirtyPathsChange', ['src/dirty.ts']);
  invoke(element(tree, 'WorkspaceEditor'), 'onSelectedPathChange', 'src/dirty.ts');
  tree = harness.render();
  const editorBefore = element(tree, 'WorkspaceEditor');
  const splitBefore = element(workspaceColumn(tree), 'WorkspaceEditorSplit');
  expect(splitBefore.props.mode).toBe('split');
  expect(splitBefore.props.editor).toBe(editorBefore);
  expect(element(tree, 'SidebarRail').props.activeView).toBe('terminal');
  invoke(editorBefore, 'onOpenLocalHistory', 'src/dirty.ts');
  tree = harness.render();
  expect(element(tree, 'ReviewSidebar').props.localHistoryDirty).toBe(true);
  expect(element(tree, 'SidebarRail').props.activeView).toBe('terminal');
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'src/clean.ts');
  tree = harness.render();
  const history = element(tree, 'ReviewSidebar');
  expect(history.props.localHistoryPath).toBe('src/clean.ts');
  expect(history.props.localHistoryDirty).toBe(false);
  const editorDuring = element(tree, 'WorkspaceEditor');
  expect(editorDuring.props.active).toBe(true);
  expect(editorDuring.props.target).toBe(editorBefore.props.target);
  expect(editorDuring.key).toBe(editorBefore.key);
  const splitDuring = element(workspaceColumn(tree), 'WorkspaceEditorSplit');
  expect(splitDuring.props.mode).toBe('split');
  expect(splitDuring.key).toBe(splitBefore.key);
  expect(splitDuring.props.editor).toBe(editorDuring);
  invoke(history, 'onCloseReview');
  tree = harness.render();
  expect(element(tree, 'SidebarRail').props.activeView).toBe('terminal');
  expect(element(tree, 'Sidebar').props.selectedFilePath).toBe('src/dirty.ts');
  expect(element(tree, 'TerminalWorkspace').props.active).toBe(true);
  expect(element(tree, 'ChatWorkspace').props.active).toBe(false);
  expect(element(tree, 'WorkspaceEditorSplit').props.mode).toBe('split');
  expect(element(tree, 'ReviewSidebar').props.localHistoryPath).toBeNull();
  expect(element(tree, 'WorkspaceEditor').props.active).toBe(true);
  expect(element(tree, 'WorkspaceEditor').props.target).toBe(editorBefore.props.target);
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'src/dirty.ts');
  tree = harness.render();
  expect(element(tree, 'ReviewSidebar').props.localHistoryDirty).toBe(true);
});

test('closing history after all editor tabs close preserves the previous chat workspace', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenWorkspaceFile', 'src/file.ts');
  tree = harness.render();
  invoke(element(tree, 'WorkspaceEditor'), 'onOpenLocalHistory', 'src/file.ts');
  tree = harness.render();
  invoke(element(tree, 'WorkspaceEditor'), 'onAllTabsClosed');
  tree = harness.render();
  invoke(element(tree, 'ReviewSidebar'), 'onCloseReview');
  tree = harness.render();
  expect(element(tree, 'SidebarRail').props.activeView).toBe('chat');
  expect(element(tree, 'WorkspaceEditorSplit').props.mode).toBe('primary');
  expect(element(tree, 'WorkspaceEditor').props.target).toBeNull();
  expect(element(tree, 'ChatWorkspace').props.active).toBe(true);
  expect(element(tree, 'ReviewSidebar').props.localHistoryPath).toBeNull();
});

test('local history and line commits replace each other in the same right panel', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'first.ts');
  tree = harness.render();
  invoke(element(tree, 'WorkspaceEditor'), 'onShowLineCommit', { path: 'first.ts', line: 2, content: 'one\ntwo' });
  tree = harness.render();
  expect(element(tree, 'ReviewSidebar').props.localHistoryPath).toBeNull();
  expect(element(tree, 'ReviewSidebar').props.lineCommit).toEqual({ path: 'first.ts', line: 2, content: 'one\ntwo' });
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'second.ts');
  tree = harness.render();
  expect(element(tree, 'ReviewSidebar').props.localHistoryPath).toBe('second.ts');
  expect(element(tree, 'ReviewSidebar').props.lineCommit).toBeNull();
});
