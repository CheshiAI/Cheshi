import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { FlatTab, FlatTabList } from '../frontend/src/shared/ui/FlatTab';
import { reorderWorkspaceTabs } from '../frontend/src/features/editor/workspaceTabOrder';
import { captureEditorSession, restoreEditorSession } from '../frontend/src/features/editor/workspaceEditorSession';
import type { WorkspaceTab } from '../frontend/src/features/editor/workspaceEditorModel';

function tabs(): WorkspaceTab[] {
  return ['a.ts', 'b.ts', 'c.ts'].map((path, index) => ({
    path,
    file: { path, name: path, kind: 'file', fileKind: 'text', size: 5, modifiedAt: 1,
      revision: 'r', hasBom: false, lineEnding: 'lf' },
    savedContent: 'saved', draftContent: 'draft', conflictMessage: null,
    previewDataUrl: null, sourceExcerpt: null, loadGeneration: index + 1,
    editorState: EditorState.create({ doc: 'draft', selection: { anchor: 3 } }),
  }));
}

test('moves tabs before or after targets in either direction without changing editor state', () => {
  const original = tabs();
  for (const [source, target, side, expected] of [
    ['a.ts', 'c.ts', 'after', ['b.ts', 'c.ts', 'a.ts']],
    ['a.ts', 'c.ts', 'before', ['b.ts', 'a.ts', 'c.ts']],
    ['c.ts', 'a.ts', 'before', ['c.ts', 'a.ts', 'b.ts']],
    ['c.ts', 'a.ts', 'after', ['a.ts', 'c.ts', 'b.ts']],
  ] as const) {
    const ordered = reorderWorkspaceTabs(original, source, target, side);
    expect(ordered.map(tab => tab.path)).toEqual([...expected]);
    for (const tab of original) expect(ordered.find(item => item.path === tab.path)).toBe(tab);
  }
  expect(original.map(tab => tab.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(original[0]!.editorState!.selection.main.anchor).toBe(3);
  expect(original[0]!.draftContent).toBe('draft');
});

test('ignores missing, self and adjacent no-op drops', () => {
  const original = tabs();
  for (const [source, target, side] of [
    ['missing', 'b.ts', 'before'], ['a.ts', 'missing', 'after'], ['a.ts', 'a.ts', 'after'],
    ['a.ts', 'b.ts', 'before'], ['b.ts', 'a.ts', 'after'],
  ] as const) expect(reorderWorkspaceTabs(original, source, target, side)).toBe(original);
});

test('session capture and restore preserve reordered paths and the selected file', async () => {
  const original = tabs();
  const ordered = reorderWorkspaceTabs(original, 'c.ts', 'a.ts', 'before');
  const session = captureEditorSession(ordered, 'b.ts');
  const restored = await restoreEditorSession(session, async path => ({
    file: original.find(tab => tab.path === path)!.file, content: 'saved', dataUrl: null,
  }), () => 1);
  expect(restored.tabs.map(tab => tab.path)).toEqual(['c.ts', 'a.ts', 'b.ts']);
  expect(restored.selectedPath).toBe('b.ts');
});

async function withDOM(run: (h: {
  render(node: ReactNode): Promise<void>;
  drag(element: Element, type: string, x?: number): Promise<Event>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const dataTransfer = new window.DataTransfer();
  try {
    await run({
      render: async node => { await act(async () => root.render(node)); },
      drag: async (element, type, x = 0) => {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientX: { value: x } });
        await act(async () => { element.dispatchEvent(event as unknown as Event); });
        return event as unknown as Event;
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function trigger(path: string) {
  const element = document.querySelector<HTMLButtonElement>(`[role="tab"][title="${path}"]`);
  if (!element) throw new Error(`Missing tab ${path}`);
  return element;
}

test('dragging reorders rendered tabs, shows insertion side and retains selection and close behavior', async () => {
  await withDOM(async ({ render, drag }) => {
    let current = tabs();
    let selected = 'b.ts';
    function EditorTabs() {
      const [items, setItems] = useState(current);
      current = items;
      return <FlatTabList onCloseAll={() => {}} onReorder={(source, target, side) => {
        setItems(value => reorderWorkspaceTabs(value, source, target, side));
      }}>
        {items.map(tab => <FlatTab key={tab.path} tabId={tab.path} title={tab.path} label={tab.path}
          active={tab.path === selected} closeLabel={`Close ${tab.path}`}
          onActivate={() => { selected = tab.path; }}
          onClose={() => setItems(value => value.filter(item => item.path !== tab.path))} />)}
      </FlatTabList>;
    }
    await render(<EditorTabs />);
    const original = current;
    const source = trigger('a.ts');
    const target = trigger('c.ts').parentElement!;
    target.getBoundingClientRect = () => ({ left: 100, width: 100 } as DOMRect);
    await drag(source, 'dragstart');
    expect((await drag(target, 'dragover', 175)).defaultPrevented).toBe(true);
    expect(target.dataset.dropSide).toBe('after');
    await drag(target, 'dragover', 125);
    expect(target.dataset.dropSide).toBe('before');
    await drag(target, 'drop', 175);
    expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['b.ts', 'c.ts', 'a.ts']);
    expect(document.querySelector('[data-drop-side]')).toBeNull();
    expect(trigger('b.ts').getAttribute('aria-selected')).toBe('true');
    expect(selected).toBe('b.ts');
    expect(current[2]).toBe(original[0]!);
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close a.ts"]')!;
    expect(close.getAttribute('draggable')).not.toBe('true');
    await act(async () => { close.click(); });
    expect(current.map(tab => tab.path)).toEqual(['b.ts', 'c.ts']);
  });
});

test('cancelled drags and external drops do not reorder and non-opted-in tabs stay non-draggable', async () => {
  await withDOM(async ({ render, drag }) => {
    const moves: string[] = [];
    const children = ['a.ts', 'b.ts'].map(path => <FlatTab key={path} tabId={path} title={path}
      label={path} active={false} closeLabel={`Close ${path}`} onActivate={() => {}} onClose={() => {}} />);
    await render(<FlatTabList onCloseAll={() => {}} onReorder={source => moves.push(source)}>{children}</FlatTabList>);
    const source = trigger('a.ts');
    const target = trigger('b.ts').parentElement!;
    expect((await drag(target, 'dragover')).defaultPrevented).toBe(false);
    await drag(target, 'drop');
    expect(moves).toEqual([]);
    await drag(source, 'dragstart');
    await drag(target, 'dragover');
    expect(document.querySelector('[data-drop-side]')).not.toBeNull();
    await drag(source, 'dragend');
    expect(document.querySelector('[data-drop-side]')).toBeNull();
    await drag(target, 'drop');
    expect(moves).toEqual([]);
    await render(<FlatTabList onCloseAll={() => {}}>{children}</FlatTabList>);
    expect(trigger('a.ts').getAttribute('draggable')).toBe('false');
  });
});
