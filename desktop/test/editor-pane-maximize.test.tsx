import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { Window } from 'happy-dom';
import { EditorPaneHost } from '../frontend/src/features/editor/EditorPaneHost';
import { createEditorPaneStore } from '../frontend/src/features/editor/editorPaneStore';
import * as fileDrop from '../frontend/src/features/editor/editorFileDrop';
import * as fileLoad from '../frontend/src/features/editor/workspaceFileLoad';
import * as layoutControls from '../frontend/src/features/shell/WorkspaceLayoutControls';
import type { WorkspaceEditor } from '../frontend/src/features/editor/WorkspaceEditor';
import type { WorkspaceEditorPane } from '../frontend/src/features/editor/WorkspaceEditorPane';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';

mock.module('../frontend/src/shared/ui/SplitPaneLayout.module.css', () => ({
  default: { split: 'split', region: 'region', separator: 'separator' },
}));
const { SplitPaneLayout } = await import('../frontend/src/shared/ui/SplitPaneLayout');
const { WorkspaceEditorSplit } = await import('../frontend/src/features/shell/WorkspaceEditorSplit');

function tab(path: string): WorkspaceTab {
  return { path, file: { path, name: path, kind: 'file', fileKind: 'text', size: 5, modifiedAt: 1,
    revision: 'r', hasBom: false, lineEnding: 'lf' }, savedContent: 'saved', draftContent: 'draft',
    conflictMessage: null, previewDataUrl: null, sourceExcerpt: null, loadGeneration: 1 };
}

async function withEditor(run: (h: {
  store: ReturnType<typeof createEditorPaneStore>;
  ids: string[];
  visible(): string[];
  toggle(id: string, restore?: boolean): Promise<void>;
  closed: string[];
  outerMaximized: string[];
}) => Promise<void>, singlePane = false, mixedWorkspace = false) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const store = createEditorPaneStore();
  store.restore([tab('a.ts'), ...(singlePane ? [] : [tab('b.ts'), tab('c.ts')])]);
  if (!singlePane) {
    const second = store.place(tab('b.ts'), 'editor-main', 'right', 'editor-main')!;
    store.place(tab('c.ts'), second, 'down', 'editor-main');
    const layout = store.getSnapshot().layout;
    if (layout.type === 'split') store.resize(layout.id, .65);
  }
  const ids = Object.keys(store.getSnapshot().groups);
  const closed: string[] = [];
  const outerMaximized: string[] = [];
  function Pane({ pane, active, maximizeControl }: React.ComponentProps<typeof WorkspaceEditorPane>) {
    React.useEffect(() => () => { closed.push(pane.id); }, [pane.id]);
    return <section data-content={pane.id} data-active={String(active)}>
      <layoutControls.WorkspaceLayoutControls maximizeControl={maximizeControl} />
      <textarea aria-label={`${pane.id} draft`} defaultValue="unsaved text" />
    </section>;
  }
  const modules: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': { createPortal },
    '../../cheshiDesktop': { cheshiDesktop: null },
    '../../shared/ui/SplitPaneLayout': { SplitPaneLayout },
    '../shell/WorkspaceLayoutControls': layoutControls,
    './WorkspaceEditorPane': { WorkspaceEditorPane: Pane },
    './useEditorPanes': { useEditorPanes: () => ({ store,
      state: React.useSyncExternalStore(store.subscribe, store.getSnapshot), ready: true, error: '', setError() {} }) },
    './EditorPaneHost': { EditorPaneHost }, './editorFileDrop': fileDrop, './workspaceFileLoad': fileLoad,
    './EditorPanes.module.css': { default: { root: 'editor-root', host: 'editor-host' } }, './workspace-editor.css': {},
  };
  const source = readFileSync(new URL('../frontend/src/features/editor/WorkspaceEditor.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: { WorkspaceEditor?: typeof WorkspaceEditor } = {};
  vm.runInNewContext(compiled.outputText, { exports, document, require: (name: string) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const Editor = exports.WorkspaceEditor!;
  const editor = <Editor active mutation={null} target={null} onAllTabsClosed={() => {}}
    onSelectedPathChange={() => {}} onShowLineCommit={() => {}} />;
  function Workspace() {
    const [layout, setLayout] = React.useState<React.ComponentProps<typeof WorkspaceEditorSplit>['layout']>({
      type: 'split', id: 'workspace', axis: 'columns', ratio: .6,
      first: { type: 'pane', paneId: 'editor' },
      second: { type: 'split', id: 'other-panes', axis: 'rows', ratio: .7,
        first: { type: 'pane', paneId: 'primary' }, second: { type: 'pane', paneId: 'terminal' } },
    });
    return <WorkspaceEditorSplit mode="split" layout={layout} onLayoutChange={setLayout}
      editor={editor} terminal={<textarea aria-label="terminal draft" defaultValue="terminal state" />}>
      <textarea aria-label="chat draft" defaultValue="chat draft" />
    </WorkspaceEditorSplit>;
  }
  try {
    await React.act(async () => root.render(mixedWorkspace ? <Workspace /> :
      <layoutControls.WorkspaceLayoutContext.Provider value={{ split() {}, startDrag() {},
        maximize: id => outerMaximized.push(id), maximized: null, canMaximize: singlePane }}>
        <layoutControls.WorkspacePaneContext.Provider value="editor">
          {editor}
        </layoutControls.WorkspacePaneContext.Provider>
      </layoutControls.WorkspaceLayoutContext.Provider>));
    await run({ store, ids, closed, outerMaximized,
      visible: () => [...container.querySelectorAll<HTMLElement>('[data-editor-pane]')]
        .filter(element => !element.closest('[hidden]')).map(element => element.dataset.editorPane!),
      toggle: async (id, restore = false) => {
        const pane = container.querySelector(`[data-content="${id}"]`)!;
        const button = pane.querySelector<HTMLButtonElement>(`button[aria-label="${restore ? 'Restore pane size' : 'Maximize pane'}"]`)!;
        expect(button.disabled).toBe(false);
        await React.act(async () => { button.focus(); button.click(); });
      },
    });
  } finally {
    await React.act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('each nested file pane maximizes and restores its exact layout without unmounting drafts', async () => {
  await withEditor(async h => {
    const layout = h.store.getSnapshot().layout;
    const snapshot = JSON.stringify(h.store.snapshot());
    const inputs = h.ids.map(id => document.querySelector<HTMLTextAreaElement>(`[aria-label="${id} draft"]`)!);
    inputs.forEach((input, index) => { input.value = `draft ${index}`; input.setSelectionRange(2, 5); });
    for (const id of h.ids) {
      await h.toggle(id);
      expect(h.visible()).toEqual([id]);
      expect(document.querySelector(`[data-content="${id}"]`)!.getAttribute('data-active')).toBe('true');
      for (const other of h.ids.filter(other => other !== id)) {
        expect(document.querySelector(`[data-content="${other}"]`)!.closest('[inert]')).not.toBeNull();
        expect(document.querySelector(`[data-content="${other}"]`)!.getAttribute('data-active')).toBe('true');
      }
      expect(h.store.getSnapshot().layout).toBe(layout);
      await h.toggle(id, true);
      expect(h.visible().sort()).toEqual([...h.ids].sort());
      expect(document.querySelectorAll('[role="separator"][aria-label="Resize editor panes"]')).toHaveLength(2);
      inputs.forEach((input, index) => {
        expect(document.querySelector(`[aria-label="${h.ids[index]} draft"]`)).toBe(input);
        expect(input.value).toBe(`draft ${index}`);
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(5);
      });
    }
    expect(h.closed).toEqual([]);
    expect(h.outerMaximized).toEqual([]);
    const original = JSON.parse(snapshot);
    expect(h.store.snapshot().groups).toEqual(original.groups);
    expect(h.store.getSnapshot().layout).toBe(layout);
  });
});

test('closing a maximized pane reveals remaining panes and preserves their drafts', async () => {
  await withEditor(async h => {
    const id = h.ids[1]!;
    await h.toggle(id);
    await React.act(async () => { h.store.replace(id, () => []); h.store.closeEmpty(id); });
    expect(h.visible().sort()).toEqual(h.ids.filter(other => other !== id).sort());
    expect(h.store.allTabs().every(item => item.draftContent === 'draft')).toBe(true);
    expect(document.querySelector('[aria-label="Restore pane size"]')).toBeNull();
  });
});

test('a split added while maximized is revealed instead of opening invisibly', async () => {
  await withEditor(async h => {
    await h.toggle(h.ids[0]!);
    let added: string | null = null;
    await React.act(async () => { added = h.store.place(tab('new.ts'), h.ids[0]!, 'down'); });
    expect(h.visible()).toContain(added!);
    expect(h.visible()).toHaveLength(4);
  });
});

test('a single file pane retains the existing outer workspace maximize action', async () => {
  await withEditor(async h => {
    await h.toggle(h.ids[0]!);
    expect(h.outerMaximized).toEqual(['editor']);
  }, true);
});

function visibleWorkspacePanes() {
  return [...document.querySelectorAll<HTMLElement>('[data-workspace-pane]')]
    .filter(element => !element.closest('[hidden]')).map(element => element.dataset.workspacePane!).sort();
}

test('file maximize fills the workspace and restores chat, terminal, split ratios and drafts', async () => {
  await withEditor(async h => {
    const layout = h.store.getSnapshot().layout;
    const inputs = ['chat', 'terminal'].map(name => document.querySelector<HTMLTextAreaElement>(`[aria-label="${name} draft"]`)!);
    inputs.forEach(input => { input.value = 'keep unsaved state'; });
    const ratios = () => [...document.querySelectorAll('[role="separator"][aria-label="Resize workspace panes"]')]
      .map(element => element.getAttribute('aria-valuenow'));
    const originalRatios = ratios();
    for (const id of h.ids) {
      await h.toggle(id);
      expect(visibleWorkspacePanes()).toEqual(['editor']);
      expect(h.visible()).toEqual([id]);
      await h.toggle(id, true);
      expect(visibleWorkspacePanes()).toEqual(['editor', 'primary', 'terminal']);
      expect(h.visible().sort()).toEqual([...h.ids].sort());
      expect(ratios()).toEqual(originalRatios);
      expect(h.store.getSnapshot().layout).toBe(layout);
      inputs.forEach(input => {
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe('keep unsaved state');
      });
    }
    expect(h.closed).toEqual([]);
  }, false, true);
});

test('closing the maximized file restores the outer workspace too', async () => {
  await withEditor(async h => {
    const id = h.ids[1]!;
    await h.toggle(id);
    expect(visibleWorkspacePanes()).toEqual(['editor']);
    await React.act(async () => { h.store.replace(id, () => []); h.store.closeEmpty(id); });
    expect(visibleWorkspacePanes()).toEqual(['editor', 'primary', 'terminal']);
    expect(h.visible().sort()).toEqual(h.ids.filter(other => other !== id).sort());
  }, false, true);
});
