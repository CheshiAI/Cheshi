import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { connectCanvasBlur } from '../frontend/open-pencil/editor/canvasBlur';

async function fixture(run: (context: {
  document: Document; source: HTMLElement; toolbar: HTMLElement;
  surface(role: string, box: string): HTMLElement;
  flush(): Promise<void>; dispose(): void; mask(): string;
}) => Promise<void>) {
  const window = new Window();
  const document = window.document as unknown as Document;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.defineProperties(window, {
    requestAnimationFrame: { value: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; } },
    cancelAnimationFrame: { value: (id: number) => frames.delete(id) },
  });
  function surface(role: string, box: string) {
    const element = document.createElement('div');
    element.setAttribute('role', role);
    element.dataset.box = box;
    element.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:12px';
    const bounds = () => {
      const [x = 0, y = 0, width = 0, height = 0] = element.dataset.box!.split(',').map(Number);
      return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON() { return {}; } };
    };
    Object.defineProperties(element, {
      offsetWidth: { get: () => bounds().width }, offsetHeight: { get: () => bounds().height },
      getBoundingClientRect: { value: bounds },
      getClientRects: { value: () => element.hidden ? [] : [bounds()] },
    });
    document.body.append(element);
    return element;
  }
  const source = surface('presentation', '0,0,800,600');
  const toolbar = surface('toolbar', '200,500,400,50');
  toolbar.dataset.testId = 'toolbar';
  const stop = connectCanvasBlur(source);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; stop(); } };
  const mask = () => decodeURIComponent(document.querySelector('feImage')?.getAttribute('href')?.split(',').slice(1).join(',') ?? '');
  const flush = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(0);
    }
  };
  try { await run({ document, source, toolbar, surface, flush, dispose, mask }); }
  finally { dispose(); await window.happyDOM.close(); }
}

test('Canvas toolbar and portalled menus share one SVG blur without filtering their foreground', async () => {
  await fixture(async ({ document, source, toolbar, surface, flush, mask }) => {
    expect(document.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    expect(source.style.filter).toContain('url(');
    expect(toolbar.style.filter).toBe('');
    expect(toolbar.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(mask().match(/<path /g)).toHaveLength(1);
    const menu = surface('menu', '20,30,200,300');
    const submenu = surface('listbox', '220,50,180,200');
    await flush();
    expect(mask().match(/<path /g)).toHaveLength(3);
    expect(document.querySelectorAll('filter')).toHaveLength(1);
    for (const element of [menu, submenu]) {
      expect(element.getAttribute('data-regional-blur-surface')).toBe('true');
      expect(element.style.filter).toBe('');
    }
    submenu.remove(); await flush();
    expect(submenu.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(mask().match(/<path /g)).toHaveLength(2);
    menu.remove(); await flush();
    expect(mask().match(/<path /g)).toHaveLength(1);
  });
});

test('Canvas blur follows moved, hidden and removed controls, then cleans up on document change', async () => {
  await fixture(async ({ document, source, toolbar, surface, flush, dispose, mask }) => {
    const before = mask();
    toolbar.dataset.box = '100,400,400,50';
    await flush();
    expect(mask()).not.toBe(before);
    expect(mask()).toContain('M112 400');
    toolbar.hidden = true; await flush();
    expect(source.style.filter).toBe('');
    expect(mask()).toBe('');
    toolbar.hidden = false; await flush();
    expect(source.style.filter).toContain('url(');
    const nested = surface('menu', '0,0,50,50');
    source.append(nested); await flush();
    expect(nested.hasAttribute('data-regional-blur-surface')).toBe(false);
    dispose();
    expect(source.style.filter).toBe('');
    expect(source.hasAttribute('data-regional-blur-source')).toBe(false);
    expect(toolbar.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(document.querySelector('filter')).toBeNull();
    const next = surface('menu', '10,10,100,100'); await flush();
    expect(next.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(document.querySelector('filter')).toBeNull();
  });
});
