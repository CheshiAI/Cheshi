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
  const modules: Record<string, unknown> = {
    react: app.react,
    '../chat/useChatWorkspace': { useChatWorkspace: () => ({ activePaneId: 'chat-a', controllers: {},
      sessionHistory: { loading: false, sessions: [] }, responseThreadIds: [], accountSwitchPending: false }) },
    '../chat/useChatHistorySearch': { useChatHistorySearch: () => ({ clear() {} }) },
    './useAppUpdateResume': { useAppUpdateResume: () => ({ busy: false, error: null }) },
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
    './ReviewSidebar': ['ReviewSidebar'], './WorkspaceStatusBar': ['WorkspaceStatusBar'],
    '../editor/LocalHistoryPage': ['LocalHistoryPage'], './WorkspaceEditorSplit': ['WorkspaceEditorSplit'],
    '../navigation/WorkspaceFileSearch': ['WorkspaceFileSearch'],
  })) modules[path] = Object.fromEntries(names.map(name => [name, name]));
  const Shell = load<typeof AppShell>('features/shell/AppShell.tsx', 'AppShell', modules, { document: {} });
  return { render: () => app.render(() => Shell()), openSearch: () => openSearch() };
}

test('file search keeps the current page and opens results through the existing editor split', () => {
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
  expect(split.mode).toBe('split');
  expect(props<ComponentProps<typeof WorkspaceEditor>>(split.editor, 'WorkspaceEditor').target?.path).toBe('src/found.ts');
  expect(elements(split.children).some(element => element.type === 'GitWorkspace')).toBe(true);
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
  expect(elements(split.children).some(element => element.type === 'GitWorkspace')).toBe(true);
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
