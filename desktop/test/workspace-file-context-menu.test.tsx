import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceFileContextMenu } from '../frontend/src/features/navigation/WorkspaceFileContextMenu';

type Entry = ComponentProps<typeof WorkspaceFileContextMenu>['entry'];
const file: NonNullable<Entry> = { path: 'src/app.ts', name: 'app.ts', kind: 'file', size: 12, modifiedAt: 0, revision: '1' };

async function withMenu(run: (h: {
  window: Window; source: HTMLElement; actions: string[];
  open(entry?: Entry): Promise<HTMLElement>; key(value: string): Promise<void>;
  closeOutside(): Promise<void>; unmount(): Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const source = document.createElement('div');
  source.id = 'app'; source.style.filter = 'brightness(0.9)';
  Object.defineProperties(source, {
    offsetWidth: { value: 1000 }, offsetHeight: { value: 800 },
    getBoundingClientRect: { value: () => new window.DOMRect(0, 0, 1000, 800) },
  });
  document.body.append(source);
  const root = createRoot(source);
  const actions: string[] = [];
  let generation = 0;
  function Scene({ entry }: { entry: Entry }) {
    const [open, setOpen] = useState(true);
    const select = (action: string) => { actions.push(action); setOpen(false); };
    return <><div>Editor and sidebar background</div>{open && <WorkspaceFileContextMenu
      entry={entry} directoryPath="src" x={200} y={100} onClose={() => setOpen(false)}
      onCreate={(path, kind) => select(`create:${path}:${kind}`)}
      onRename={entry => select(`rename:${entry.path}`)} onMove={entry => select(`move:${entry.path}`)}
      onCopyFullPath={entry => select(`copy:${entry.path}`)} onDelete={entry => select(`delete:${entry.path}`)}
      onOpenLocalHistory={entry => select(`history:${entry.path}`)} />}</>;
  }
  try {
    await run({ window, source, actions,
      open: async (entry = file) => {
        await act(async () => root.render(<Scene key={++generation} entry={entry} />));
        const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
        menu.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:12px';
        Object.defineProperties(menu, {
          getBoundingClientRect: { value: () => new window.DOMRect(200, 100, 180, 220) },
          getClientRects: { value: () => [new window.DOMRect(200, 100, 180, 220)] },
        });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
        return menu;
      },
      key: async key => { await act(async () => document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event)); },
      closeOutside: async () => { await act(async () => source.dispatchEvent(
        new window.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event)); },
      unmount: async () => { await act(async () => root.render(null)); },
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

test('file context menu shares the 16px SVG blur across the editor scene and restores it after dismissal', async () => {
  await withMenu(async h => {
    const menu = await h.open();
    expect(h.source.contains(menu)).toBe(false);
    expect(menu.style.filter).toBe('');
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    const filter = document.getElementById(h.source.getAttribute('data-regional-blur-source')!)!;
    expect(h.source.style.filter).toContain('url(');
    expect(filter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    const mask = decodeURIComponent(filter.querySelector('feImage')!.getAttribute('href')!.split(',').slice(1).join(','));
    expect(mask).toContain('M212 100');
    expect(document.activeElement?.textContent).toBe('Local history');
    await h.key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Rename');
    await h.key('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(h.source.style.filter).toBe('brightness(0.9)');
    for (const close of [h.closeOutside, h.unmount]) {
      await h.open(); await close();
      expect(h.source.style.filter).toBe('brightness(0.9)');
      expect(h.source.hasAttribute('data-regional-blur-source')).toBe(false);
      expect(document.querySelector('filter')).toBeNull();
    }
  });
});

test('file context menu preserves file actions and directory creation with SVG blur enabled', async () => {
  await withMenu(async h => {
    const expected = ['history:src/app.ts', 'rename:src/app.ts', 'move:src/app.ts', 'copy:src/app.ts', 'delete:src/app.ts'];
    for (let index = 0; index < expected.length; index++) {
      const menu = await h.open();
      await act(async () => menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index]!.click());
      expect(h.actions.at(-1)).toBe(expected[index]);
      expect(h.source.style.filter).toBe('brightness(0.9)');
    }
    for (const entry of [null, { ...file, path: 'src', name: 'src', kind: 'directory' as const }]) {
      const menu = await h.open(entry);
      expect(menu.textContent).not.toContain('Local history');
      expect(menu.querySelectorAll('[role="separator"]').length).toBe(entry ? 1 : 0);
      await act(async () => menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click());
      expect(h.actions.at(-1)).toBe('create:src:directory');
      expect(h.source.style.filter).toBe('brightness(0.9)');
    }
  });
});
