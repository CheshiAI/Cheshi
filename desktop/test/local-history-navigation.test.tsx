import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

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
  return isElement(value) ? [value, ...elements(value.props.editor), ...elements(value.props.children)] : [];
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
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: unknown) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        }];
      },
      useCallback(callback: unknown) { return callback; },
      useEffect() {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../shared/ui': { LiquidGlassPanel: 'LiquidGlassPanel' },
    '../chat': { ChatSessionList: 'ChatSessionList' },
    '../chat/ChatWorkspace': { ChatWorkspace: 'ChatWorkspace' },
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
    '../navigation/WorkspaceFileSearch': { WorkspaceFileSearch: 'WorkspaceFileSearch' },
    '../plugins': { PluginsView: 'PluginsView' },
    '../terminal': { TerminalWorkspace: 'TerminalWorkspace' },
    '../showcase/ShowcaseView': { ShowcaseView: 'ShowcaseView' },
    './ReviewSidebar': { ReviewSidebar: 'ReviewSidebar' },
    './WorkspaceStatusBar': { WorkspaceStatusBar: 'WorkspaceStatusBar' },
    './WorkspaceContentSplit': { WorkspaceContentSplit: 'WorkspaceContentSplit' },
    './useAppUpdateResume': { useAppUpdateResume: () => ({ busy: false, error: null }) },
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

test('explorer history opens a workspace page with file selection and draft protection', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onNavigate', 'git');
  invoke(element(tree, 'WorkspaceEditor'), 'onDirtyPathsChange', ['src/dirty.ts']);
  tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'src/dirty.ts');
  tree = harness.render();
  expect(element(tree, 'Sidebar').props.activeView).toBe('local-history');
  expect(element(tree, 'Sidebar').props.selectedFilePath).toBe('src/dirty.ts');
  const history = element(workspaceColumn(tree), 'LocalHistoryPage');
  expect(history.props.path).toBe('src/dirty.ts');
  expect(history.props.draftDirty).toBe(true);
  expect(history.key).toBe('src/dirty.ts');
  const footer = element(tree, 'WorkspaceStatusBar');
  expect(Object.keys(footer.props).filter((name) => /history/i.test(name))).toEqual([]);
  invoke(history, 'onClose');
  tree = harness.render();
  expect(element(tree, 'Sidebar').props.activeView).toBe('git');
  expect(elements(tree).some((item) => item.type === 'LocalHistoryPage')).toBe(false);
});

test('switching history files keeps the editor active and returns to the original right page', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenWorkspaceFile', 'src/dirty.ts');
  invoke(element(tree, 'WorkspaceEditor'), 'onDirtyPathsChange', ['src/dirty.ts']);
  tree = harness.render();
  const editorBefore = element(tree, 'WorkspaceEditor');
  const splitBefore = element(tree, 'WorkspaceContentSplit');
  expect(splitBefore.props.editorOpen).toBe(true);
  expect(element(splitBefore.props.editor, 'WorkspaceEditor')).toBe(editorBefore);
  invoke(editorBefore, 'onOpenLocalHistory', 'src/dirty.ts');
  tree = harness.render();
  expect(element(tree, 'LocalHistoryPage').props.draftDirty).toBe(true);
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'src/clean.ts');
  tree = harness.render();
  const history = element(workspaceColumn(tree), 'LocalHistoryPage');
  expect(history.props.path).toBe('src/clean.ts');
  expect(history.props.draftDirty).toBe(false);
  expect(history.key).toBe('src/clean.ts');
  const editorDuring = element(tree, 'WorkspaceEditor');
  expect(editorDuring.props.active).toBe(true);
  expect(editorDuring.props.target).toBe(editorBefore.props.target);
  expect(editorDuring.key).toBe(editorBefore.key);
  const splitDuring = element(tree, 'WorkspaceContentSplit');
  expect(splitDuring.key).toBe(splitBefore.key);
  expect(element(splitDuring.props.editor, 'WorkspaceEditor')).toBe(editorDuring);
  invoke(history, 'onClose');
  tree = harness.render();
  expect(element(tree, 'Sidebar').props.activeView).toBe('chat');
  expect(element(tree, 'WorkspaceEditor').props.active).toBe(true);
  expect(element(tree, 'WorkspaceEditor').props.target).toBe(editorBefore.props.target);
  invoke(element(tree, 'Sidebar'), 'onOpenLocalHistory', 'src/dirty.ts');
  tree = harness.render();
  expect(element(tree, 'LocalHistoryPage').props.draftDirty).toBe(true);
});

for (const page of ['chat', 'terminal'] as const) {
  for (const source of ['explorer', 'search'] as const) {
    test(`${source} opens a file beside the active ${page} page without changing sidebar visibility`, () => {
      const harness = createHarness();
      let tree = harness.render();
      expect(element(tree, 'WorkspaceContentSplit').props.editorOpen).toBe(false);
      expect(element(tree, 'WorkspaceEditor').props.active).toBe(false);
      invoke(element(tree, 'Sidebar'), 'onNavigate', page);
      const pageType = page === 'chat' ? 'ChatWorkspace' : 'TerminalWorkspace';
      tree = harness.render();
      invoke(element(tree, pageType), 'onToggleRightSidebar');
      tree = harness.render();
      if (source === 'explorer') invoke(element(tree, 'Sidebar'), 'onOpenWorkspaceFile', 'src/file.ts');
      else invoke(element(tree, 'WorkspaceFileSearch'), 'onOpenFile', 'src/file.ts');
      tree = harness.render();
      const split = element(tree, 'WorkspaceContentSplit');
      expect(split.props.editorOpen).toBe(true);
      const editor = element(split.props.editor, 'WorkspaceEditor');
      expect(editor.props.active).toBe(true);
      expect(editor.props.target).toEqual({ path: 'src/file.ts', line: null, requestId: 1 });
      expect(element(tree, 'Sidebar').props.activeView).toBe(page);
      expect(element(split.props.children, pageType).props.active).toBe(true);
      expect(element(tree, 'ReviewSidebar').props.open).toBe(false);
    });
  }
}

test('page navigation preserves the open editor and subsequent file requests reuse it', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenWorkspaceFile', 'src/first.ts', 8);
  tree = harness.render();
  const firstEditor = element(tree, 'WorkspaceEditor');
  for (const page of ['terminal', 'git', 'chat']) {
    invoke(element(tree, 'Sidebar'), 'onNavigate', page);
    tree = harness.render();
    expect(element(tree, 'Sidebar').props.activeView).toBe(page);
    const retained = element(tree, 'WorkspaceEditor');
    expect(retained.props.active).toBe(true);
    expect(retained.props.target).toBe(firstEditor.props.target);
    expect(element(tree, 'WorkspaceContentSplit').props.editorOpen).toBe(true);
  }
  invoke(element(tree, 'WorkspaceFileSearch'), 'onOpenFile', 'src/second.ts');
  tree = harness.render();
  const nextEditor = element(tree, 'WorkspaceEditor');
  expect(elements(tree).filter((item) => item.type === 'WorkspaceEditor')).toHaveLength(1);
  expect(nextEditor.key).toBe(firstEditor.key);
  expect(nextEditor.props.target).toEqual({ path: 'src/second.ts', line: null, requestId: 2 });
  expect(element(tree, 'ChatWorkspace').props.active).toBe(true);
});

test('closing the final editor tab preserves the right page and clears the previous target', () => {
  const harness = createHarness();
  let tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onNavigate', 'terminal');
  tree = harness.render();
  invoke(element(tree, 'Sidebar'), 'onOpenWorkspaceFile', 'src/file.ts');
  tree = harness.render();
  invoke(element(tree, 'WorkspaceEditor'), 'onAllTabsClosed');
  tree = harness.render();
  expect(element(tree, 'WorkspaceContentSplit').props.editorOpen).toBe(false);
  expect(element(tree, 'WorkspaceEditor').props.active).toBe(false);
  expect(element(tree, 'WorkspaceEditor').props.target).toBeNull();
  expect(element(tree, 'Sidebar').props.activeView).toBe('terminal');
  expect(element(tree, 'TerminalWorkspace').props.active).toBe(true);
  invoke(element(tree, 'WorkspaceFileSearch'), 'onOpenFile', 'src/reopened.ts');
  tree = harness.render();
  expect(element(tree, 'WorkspaceContentSplit').props.editorOpen).toBe(true);
  expect(element(tree, 'WorkspaceEditor').props.target).toEqual({ path: 'src/reopened.ts', line: null, requestId: 2 });
  expect(element(tree, 'TerminalWorkspace').props.active).toBe(true);
});
