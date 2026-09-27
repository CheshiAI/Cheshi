import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import { useGraphController } from '../frontend/src/features/graph/useGraphController';
import { splitPaneIds, type SplitLayoutNode } from '../frontend/src/shared/ui/splitPaneModel';
import { workspacePaneDragType } from '../frontend/src/features/shell/WorkspaceLayoutControls';

mock.module('../frontend/src/shared/ui/SplitPaneLayout.module.css', () => ({
  default: { split: 'split', region: 'region', separator: 'separator' },
}));

async function withGraph(run: (h: {
  window: Window;
  layout(): SplitLayoutNode;
  click(label: string): Promise<void>;
  opened: string[];
}) => Promise<void>, { loaded = false, single = false } = {}) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { GraphWorkspace } = await import('../frontend/src/features/graph/GraphWorkspace');
  const { GraphSettings } = await import('../frontend/src/features/graph/GraphSidebar');
  const { WorkspaceEditorSplit } = await import('../frontend/src/features/shell/WorkspaceEditorSplit');
  const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 1200, 800);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [];
  let current: SplitLayoutNode = single ? { type: 'pane', paneId: 'primary' } : {
    type: 'split', id: 'workspace', axis: 'columns', ratio: .65,
    first: { type: 'pane', paneId: 'primary' }, second: { type: 'pane', paneId: 'editor' },
  };
  function Fixture() {
    const [layout, setLayout] = useState(current);
    const [hasGraph, setHasGraph] = useState(loaded);
    const graph = useGraphController(false);
    const node = {
      id: 'root', name: 'example', qualifiedName: 'example', kind: 'function', filePath: 'example.ts',
      language: 'typescript', startLine: 1, endLine: 2, group: 'example',
    };
    const controller: ReturnType<typeof useGraphController> = {
      ...graph,
      graph: hasGraph ? { rootId: 'root', depth: 1, truncated: false, edges: [], nodes: [node] } : null,
      details: hasGraph ? { node, code: null, callers: [], callees: [] } : null,
      closeGraphView: () => { graph.closeGraphView(); setHasGraph(false); },
    };
    return <WorkspaceEditorSplit mode={single ? 'primary' : 'split'} layout={layout}
      onLayoutChange={next => { current = next; setLayout(next); }} onOpenPane={id => opened.push(id)}
      editor={<textarea aria-label="Editor draft" defaultValue="unsaved draft" />} terminal={<div>Terminal</div>}>
      <GraphWorkspace graph={controller} inspector={<GraphSettings graph={controller} />}
        rightSidebarOpen={false} onToggleRightSidebar={() => {}} />
    </WorkspaceEditorSplit>;
  }
  try {
    await act(async () => root.render(<Fixture />));
    await run({ window, opened, layout: () => current, click: async label => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-label') === label || button.textContent?.startsWith(label));
      if (!button) throw new Error(`Missing control: ${label}`);
      expect(button.disabled).toBe(false);
      await act(async () => { button.focus(); button.click(); });
    } });
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.getBoundingClientRect = originalBounds;
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test.each([false, true])('graph pane maximizes and restores with loaded=%s without losing state', async loaded => {
  await withGraph(async h => {
    const graph = document.querySelector('.codegraph-workspace')!;
    const scene = document.querySelector('.codegraph-scene');
    expect(Boolean(scene)).toBe(loaded);
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="Editor draft"]')!;
    const original = h.layout();
    draft.value = 'keep this draft';
    expect(graph.querySelector('[aria-label="Move workspace pane"]')).not.toBeNull();
    await h.click('Maximize pane');
    expect(document.querySelector('[data-workspace-pane="editor"]')!.closest('[hidden]')).not.toBeNull();
    expect(graph.closest('[hidden]')).toBeNull();
    await h.click('Restore pane size');
    expect(document.querySelector('[data-workspace-pane="editor"]')!.closest('[hidden]')).toBeNull();
    expect(document.querySelector('.codegraph-workspace')).toBe(graph);
    expect(document.querySelector('.codegraph-scene')).toBe(scene);
    expect(document.querySelector('[aria-label="Editor draft"]')).toBe(draft);
    expect(draft.value).toBe('keep this draft');
    expect(h.layout()).toBe(original);
  }, { loaded });
});

test.each(['right', 'down'] as const)('empty graph can open a %s split through the shared preview', async direction => {
  await withGraph(async h => {
    await h.click(`Split area ${direction}`);
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    await h.click('Editor');
    expect(h.opened).toEqual(['editor']);
    expect(h.layout()).toMatchObject({ type: 'split', axis: direction === 'right' ? 'columns' : 'rows' });
    expect(splitPaneIds(h.layout())).toEqual(['primary', 'editor']);
    expect(document.querySelector('.codegraph-empty-state')).not.toBeNull();
  }, { single: true });
});

test('graph drag handle moves its workspace pane and retains the graph instance', async () => {
  await withGraph(async h => {
    const graph = document.querySelector('.codegraph-workspace')!;
    const drag = graph.querySelector<HTMLButtonElement>('[aria-label="Move workspace pane"]')!;
    const target = document.querySelector('[data-workspace-pane="editor"]')!;
    const transfer = new h.window.DataTransfer();
    const dispatch = (element: Element, type: string) => {
      const event = new h.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: 1199 }, clientY: { value: 400 } });
      element.dispatchEvent(event as unknown as Event);
    };
    expect(drag.getAttribute('draggable')).toBe('true');
    await act(async () => dispatch(drag, 'dragstart'));
    expect(transfer.getData(workspacePaneDragType)).toBe('primary');
    await act(async () => { dispatch(target, 'dragover'); dispatch(target, 'drop'); dispatch(drag, 'dragend'); });
    expect(splitPaneIds(h.layout())).toEqual(['editor', 'primary']);
    expect(document.querySelector('.codegraph-workspace')).toBe(graph);
  });
});

test('a single graph retains split controls while maximize is disabled', async () => {
  await withGraph(async () => {
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Maximize pane"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Split area right"]')!.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Split area down"]')!.disabled).toBe(false);
  }, { single: true });
});

test('graph settings and the floating controls share scrollbar activity tracking', async () => {
  await withGraph(async h => {
    const workspace = document.querySelector('.codegraph-workspace')!;
    expect(workspace.hasAttribute('data-auto-hide-scrollbars')).toBe(true);
    for (const selector of ['.codegraph-settings', '.codegraph-graph-controls']) {
      const surface = workspace.querySelector(selector)!;
      surface.dispatchEvent(new h.window.Event('scroll') as unknown as Event);
      expect(surface.getAttribute('data-scrollbar-active')).toBe('true');
    }
  }, { loaded: true });
});

test('loaded graph keeps view controls over its content, outside settings and the transformed canvas', async () => {
  await withGraph(async h => {
    expect(document.querySelector('.codegraph-toolbar-title')?.textContent).toBe('Relationship Graph');
    const controls = [...document.querySelectorAll('.codegraph-toolbar-actions button, .codegraph-toolbar-actions input')]
      .map(element => element.getAttribute('aria-label') ?? element.textContent);
    expect(controls.slice(0, 4)).toEqual([
      'Move workspace pane', 'Split area right', 'Split area down', 'Maximize pane',
    ]);
    expect(document.querySelector('.codegraph-toolbar [aria-label="Graph zoom percentage"]')).toBeNull();
    const group = document.querySelector('.codegraph-workspace-content > [aria-label="Graph view controls"]')!;
    expect(group).not.toBeNull();
    expect(group.closest('.codegraph-canvas')).toBeNull();
    expect(document.querySelector('.codegraph-settings [aria-label="Graph view controls"]')).toBeNull();
    const viewControls = [...group.querySelectorAll('button, input')]
      .map(element => element.getAttribute('aria-label') ?? element.textContent);
    expect(viewControls).toEqual([
      'Zoom out', 'Graph zoom percentage', 'Zoom in', 'Fit', 'Reset graph zoom to 100%', 'Close graph',
    ]);
    await h.click('Close graph');
    expect(document.querySelector('.codegraph-graph-controls')).toBeNull();
    expect(document.querySelector('.codegraph-settings [aria-label="Group graph by"]')).not.toBeNull();
    expect(document.querySelector('.codegraph-empty-state')).not.toBeNull();
    expect(document.querySelector('[aria-label="Move workspace pane"]')).not.toBeNull();
  }, { loaded: true });
});

test('zoom entry applies at the viewport center, clamps values and cancels invalid drafts', async () => {
  await withGraph(async h => {
    const field = document.querySelector<HTMLInputElement>('[aria-label="Graph zoom percentage"]')!;
    const stage = document.querySelector<HTMLElement>('.codegraph-stage')!;
    const enter = async (value: string, key: string | null = 'Enter') => {
      await act(async () => { field.focus(); });
      await act(async () => {
        Object.getOwnPropertyDescriptor(h.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new h.window.Event('input', { bubbles: true }) as unknown as Event);
      });
      await act(async () => {
        if (key === null) field.blur();
        else field.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event);
      });
    };
    await enter('200');
    expect(field.value).toBe('200%');
    expect(stage.style.transform).toBe('translate3d(-552px, -352px, 0) scale(2)');
    await enter('25%', 'Escape');
    expect(field.value).toBe('200%');
    for (const invalid of ['', 'abc', 'Infinity', '1000', '12.5', '-10']) {
      await enter(invalid);
      expect(field.value).toBe('200%');
    }
    await enter('999');
    expect(field.value).toBe('999%');
    await h.click('Zoom in');
    expect(field.value).toBe('999%');
    await enter('9999%');
    expect(field.value).toBe('999%');
    await enter('0');
    expect(field.value).toBe('5%');
    await enter('125%');
    expect(field.value).toBe('125%');
    await h.click('Zoom out');
    expect(field.value).toBe('100%');
    await h.click('Zoom in');
    expect(field.value).toBe('125%');
    await h.click('Reset graph zoom to 100%');
    expect(field.value).toBe('100%');
    await enter('75', null);
    expect(field.value).toBe('75%');
  }, { loaded: true });
});
