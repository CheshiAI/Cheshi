import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { WorkspaceFileTree } from '../frontend/src/features/navigation/WorkspaceFileTree';
import type { WorkspaceFileTreeController } from '../frontend/src/features/navigation/useWorkspaceFileTreeController';
import type { CheshiWorkspaceEntry } from '../frontend/src/cheshiDesktop';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

// Inject the controller at the feature boundary without changing process-wide module mocks.
function explorerComponent(controller: WorkspaceFileTreeController) {
  const file = new URL('../frontend/src/features/navigation/WorkspaceFileTree.tsx', import.meta.url);
  const require = createRequire(file);
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports = {} as { WorkspaceFileTree: typeof WorkspaceFileTree };
  vm.runInNewContext(source.outputText, { exports, require(name: string) {
    if (name === './useWorkspaceFileTreeController') return { useWorkspaceFileTreeController: () => controller };
    return require(name);
  } });
  return exports.WorkspaceFileTree;
}

async function withExplorer(run: (h: {
  document: Document; controller: WorkspaceFileTreeController; opened: string[];
  viewport: HTMLElement; button: HTMLButtonElement; file: CheshiWorkspaceEntry;
  render: () => Promise<void>; idle: () => Promise<void>;
  pointer: (target: Element, type: string, y: number, x?: number) => Promise<void>;
  wheel: (deltaY: number) => Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    ResizeObserver: window.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const document = window.document as unknown as Document;
  const host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  const opened: string[] = [];
  const file: CheshiWorkspaceEntry = { path: 'file.ts', name: 'file.ts', kind: 'file',
    size: 1, modifiedAt: 1, revision: 'one' };
  const directory: CheshiWorkspaceEntry = { ...file, path: 'src', name: 'src', kind: 'directory' };
  const controller = {
    entryEdit: null, mutatingPath: null, loadingDirectory: null, refreshing: false, error: null,
    rootExpanded: true, expandedDirectories: new Set(['.']), gitChangedPaths: new Set<string>(),
    entryEditInputRef: { current: null }, entryEditValue: 'file.ts', contextMenu: null,
    visibleEntries: [{ entry: directory, depth: 0 }, { entry: file, depth: 0 }],
    refreshWorkspaceFiles: async () => {}, activateEntry: (entry: CheshiWorkspaceEntry) => { opened.push(entry.path); },
    setEntryEditValue: () => {}, cancelEntryEdit: () => {},
  } as unknown as WorkspaceFileTreeController;
  const Tree = explorerComponent(controller);
  const render = async () => { await act(async () => root.render(
    <Tree selectedPath="file.ts" onEntryMutation={() => {}} onOpenFile={() => {}} />,
  )); };
  try {
    await render();
    const viewport = document.querySelector<HTMLElement>('[aria-label="Workspace files"]')!;
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh project explorer"]')!;
    await run({ document, controller, opened, viewport, button, file, render,
      idle: async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); }); },
      pointer: async (target, type, y, x = 10) => { await act(async () => {
        const event = new window.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
          clientY: y, clientX: x, button: 0, bubbles: true, cancelable: true });
        if (type === 'pointerdown') target.dispatchEvent(event as unknown as Event);
        else window.dispatchEvent(event);
      }); },
      wheel: async deltaY => { await act(async () => {
        viewport.dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }) as unknown as Event);
      }); },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('Explorer overscroll starts only at the top and shares pending state with the refresh button', async () => {
  await withExplorer(async h => {
    const gate = createDeferred();
    let calls = 0;
    h.controller.refreshWorkspaceFiles = async () => { calls++; await gate.promise; };
    await h.render();
    h.viewport.scrollTop = 30;
    await h.wheel(-60);
    h.viewport.scrollTop = 0;
    await h.wheel(-100); await h.idle();
    expect(calls).toBe(0);
    await h.wheel(-80);
    const status = h.document.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe('Release to refresh');
    expect(calls).toBe(0);
    await h.idle();
    expect(calls).toBe(1);
    expect(h.button.disabled).toBe(true);
    expect(h.document.querySelector('[role="status"]')).toBe(status);
    await act(async () => h.button.click());
    await h.wheel(-100); await h.idle();
    expect(calls).toBe(1);
    expect(h.document.querySelector('[aria-selected="true"]')?.textContent).toBe('file.ts');
    await act(async () => gate.resolve());
    expect(h.document.querySelector('[role="status"]')).toBeNull();
    expect(h.button.disabled).toBe(false);
    await act(async () => h.button.click());
    expect(calls).toBe(2);
  });
});

test('Explorer drag refreshes on release and suppresses the resulting folder click', async () => {
  await withExplorer(async h => {
    let calls = 0;
    h.controller.refreshWorkspaceFiles = async () => { calls++; };
    await h.render();
    const folder = h.document.querySelector<HTMLButtonElement>('[role="treeitem"]')!;
    for (const [y, x, end] of [[30, 10, 'pointerup'], [20, 100, 'pointerup'], [100, 10, 'pointercancel']] as const) {
      await h.pointer(folder, 'pointerdown', 10);
      await h.pointer(folder, 'pointermove', y, x);
      await h.pointer(folder, end, y, x);
    }
    expect(calls).toBe(0);
    await h.pointer(folder, 'pointerdown', 10);
    await h.pointer(folder, 'pointermove', 100);
    expect(calls).toBe(0);
    await h.pointer(folder, 'pointerup', 100);
    expect(calls).toBe(1);
    const MouseEvent = h.document.defaultView!.MouseEvent;
    await act(async () => folder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
    expect(h.opened).toEqual([]);
    await act(async () => folder.click());
    expect(h.opened).toEqual(['src']);
  });
});

test('native file dragging and editing do not start Explorer refresh gestures', async () => {
  await withExplorer(async h => {
    let calls = 0;
    h.controller.refreshWorkspaceFiles = async () => { calls++; };
    await h.render();
    const row = h.document.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
    // Production file rows are draggable when the desktop API provides a workspace root.
    row.setAttribute('draggable', 'true');
    await h.pointer(row, 'pointerdown', 10);
    await h.pointer(row, 'pointermove', 100);
    await h.pointer(row, 'pointerup', 100);
    expect(calls).toBe(0);
    expect(h.document.querySelector('[role="status"]')).toBeNull();
    h.controller.entryEdit = { mode: 'rename', entry: h.file };
    await h.render();
    const input = h.document.querySelector<HTMLInputElement>('input[aria-label="Rename file.ts"]')!;
    await h.pointer(input, 'pointerdown', 10);
    await h.pointer(input, 'pointermove', 100);
    await h.pointer(input, 'pointerup', 100);
    await h.wheel(-100); await h.idle();
    expect(calls).toBe(0);
    expect(input.value).toBe('file.ts');
    expect(h.button.disabled).toBe(true);
  });
});
