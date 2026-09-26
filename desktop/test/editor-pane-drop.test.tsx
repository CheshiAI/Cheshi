import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { EditorPaneHost } from '../frontend/src/features/editor/EditorPaneHost';
import { FlatTab, FlatTabList } from '../frontend/src/shared/ui/FlatTab';
import { EDITOR_TAB_TRANSFER_TYPE } from '../frontend/src/features/editor/editorFileDrop';
import { WORKSPACE_FILE_TRANSFER_TYPE } from '../frontend/src/shared/workspaceFileTransfer';

async function withDropPane(run: (h: {
  host: HTMLElement;
  mount: HTMLElement;
  drop: Array<string | null>;
  reordered: string[][];
  drag(target: Element, type: string, x: number, y: number, mime?: string): Promise<Event>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const host = document.createElement('div');
  const drop: Array<string | null> = [];
  const reordered: string[][] = [];
  const dataTransfer = new window.DataTransfer();
  try {
    await act(async () => root.render(<>
      <EditorPaneHost host={host} id="editor-main" onDetach={() => {}} onDrop={(_data, _id, direction) => drop.push(direction)} />
      {createPortal(<>
        <FlatTabList onCloseAll={() => {}} onReorder={(source, target, side) => reordered.push([source, target, side])}
          onTabDragStart={(event, path) => event.dataTransfer.setData(EDITOR_TAB_TRANSFER_TYPE, JSON.stringify({ paneId: 'editor-main', path }))}>
          {['a.ts', 'b.ts'].map(path => <FlatTab key={path} tabId={path} title={path} label={path}
            active={path === 'a.ts'} closeLabel={`Close ${path}`} onActivate={() => {}} onClose={() => {}} />)}
        </FlatTabList>
        <section className="workspace-editor-stage"><div className="cm-content">content</div></section>
      </>, host)}
    </>));
    const mount = container.querySelector<HTMLElement>('[data-editor-pane]')!;
    const bounds = { x: 0, y: 0, top: 0, left: 0, right: 500, bottom: 400, width: 500, height: 400, toJSON: () => ({}) };
    mount.getBoundingClientRect = () => bounds;
    host.querySelector<HTMLElement>('.workspace-editor-stage')!.getBoundingClientRect = () => bounds;
    await run({ host, mount, drop, reordered,
      drag: async (target, type, x, y, mime) => {
        if (mime) { dataTransfer.clearData(); dataTransfer.setData(mime, '[]'); }
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientX: { value: x }, clientY: { value: y } });
        await act(async () => { target.dispatchEvent(event as unknown as Event); });
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

test('file drops reach portal-hosted editor edges and center, and clear their preview', async () => {
  await withDropPane(async h => {
    const content = h.host.querySelector('.cm-content')!;
    for (const [x, y, direction] of [[10, 200, 'left'], [490, 200, 'right'], [250, 10, 'up'], [250, 390, 'down'], [250, 200, null]] as const) {
      const event = await h.drag(content, 'dragover', x, y, WORKSPACE_FILE_TRANSFER_TYPE);
      expect(event.defaultPrevented).toBe(true);
      expect(h.mount.dataset.editorDrop).toBe(direction ?? 'center');
      await h.drag(content, 'drop', x, y);
      expect(h.drop.at(-1)).toBe(direction);
      expect(h.mount.dataset.editorDrop).toBeUndefined();
    }
    const external = await h.drag(content, 'dragover', 20, 20, 'text/plain');
    expect(external.defaultPrevented).toBe(false);
    expect(h.mount.dataset.editorDrop).toBeUndefined();
  });
});

test('same-list tab reordering takes precedence over editor pane drops', async () => {
  await withDropPane(async h => {
    const [a, b] = [...h.host.querySelectorAll('[role=tab]')];
    await h.drag(a!, 'dragstart', 10, 20);
    await h.drag(b!, 'dragover', 100, 20);
    await h.drag(b!, 'drop', 100, 20);
    expect(h.reordered).toEqual([['a.ts', 'b.ts', 'after']]);
    expect(h.drop).toEqual([]);
    await h.drag(a!, 'dragend', 100, 20);
    expect(h.mount.dataset.editorDrop).toBeUndefined();
  });
});
