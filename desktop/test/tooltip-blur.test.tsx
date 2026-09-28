import { expect, test } from 'bun:test';
import { Window, type HTMLElement as TestElement } from 'happy-dom';
import { registerTooltipBlur } from '../frontend/src/shared/ui/tooltipBlur';

async function withScene(run: (scene: ReturnType<typeof sceneFixture>) => Promise<void> | void) {
  const scene = sceneFixture();
  try { await run(scene); }
  finally { scene.cleanups.reverse().forEach(cleanup => cleanup()); await scene.window.happyDOM.close(); }
}

function sceneFixture() {
  const window = new Window();
  const document = window.document;
  const cleanups: (() => void)[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.defineProperties(window, {
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback); return nextFrame;
    } },
    cancelAnimationFrame: { configurable: true, value: (id: number) => { frames.delete(id); } },
  });
  const element = (parent: TestElement = document.body, box = [0, 0, 800, 600]) => {
    const node = document.createElement('div');
    const [x, y, width, height] = box;
    node.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:8px';
    Object.defineProperties(node, {
      offsetWidth: { configurable: true, value: width }, offsetHeight: { configurable: true, value: height },
      getBoundingClientRect: { configurable: true, value: () => new window.DOMRect(x, y, width, height) },
      getClientRects: { configurable: true, value: () => [new window.DOMRect(x, y, width, height)] },
    });
    parent.append(node);
    return node;
  };
  const tooltip = (parent: TestElement = document.body, x = 100) => {
    const portal = element(parent);
    portal.dataset.tooltipBlurPortal = 'true';
    const panel = element(portal, [x, 100, 180, 60]);
    const cleanup = registerTooltipBlur(panel as unknown as HTMLElement);
    cleanups.push(cleanup);
    return { panel, portal, close: () => { cleanup(); portal.remove(); } };
  };
  const filterFor = (node: ReturnType<typeof element>) => document.getElementById(node.getAttribute('data-regional-blur-source')!)!;
  const maskFor = (node: ReturnType<typeof element>) => decodeURIComponent(filterFor(node).querySelector('feImage')!.getAttribute('href')!.split(',').slice(1).join(','));
  const flush = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  };
  return { window, document, cleanups, element, tooltip, filterFor, maskFor, flush };
}

test('automatic tooltips share one filter per scene, include portal backgrounds and preserve prior filters', async () => {
  await withScene(s => {
    const app = s.element(), menu = s.element();
    app.style.setProperty('filter', 'brightness(0.9)', 'important');
    const first = s.tooltip();
    const appFilter = s.filterFor(app), menuFilter = s.filterFor(menu);
    expect(app.style.filter).toContain('brightness(0.9)');
    expect(app.style.filter).toContain('url(');
    expect(appFilter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    expect(s.maskFor(app)).toContain('M108 100');
    const second = s.tooltip(s.document.body, 400);
    expect(s.filterFor(app)).toBe(appFilter);
    expect(s.filterFor(menu)).toBe(menuFilter);
    expect(s.maskFor(app).match(/<path /g)?.length).toBe(2);
    expect(first.panel.style.filter).toBe('');
    expect(second.portal.style.filter).toBe('');
    first.close();
    expect(s.maskFor(app).match(/<path /g)?.length).toBe(1);
    expect(app.style.filter).toContain('url(');
    second.close();
    expect(app.style.filter).toBe('brightness(0.9)');
    expect(app.style.getPropertyPriority('filter')).toBe('important');
    expect(menu.style.filter).toBe('');
    expect(s.document.querySelector('filter')).toBeNull();
    expect(app.hasAttribute('data-regional-blur-source')).toBe(false);
  });
});

test('tooltips inside a dialog blur its content without filtering their own foreground or replacing the modal filter', async () => {
  await withScene(s => {
    const app = s.element();
    app.style.filter = 'url("#modal-filter")';
    const dialog = s.element();
    const content = s.element(dialog);
    const tooltip = s.tooltip(dialog);
    expect(dialog.style.filter).toBe('');
    expect(content.style.filter).toContain('url(');
    expect(app.style.filter).toContain('modal-filter');
    expect(tooltip.panel.style.filter).toBe('');
    expect(tooltip.panel.getAttribute('data-regional-blur-surface')).toBe('true');
    tooltip.close();
    expect(content.style.filter).toBe('');
    expect(app.style.filter).toBe('url("#modal-filter")');
  });
});

test('open tooltips follow added and removed background roots and refresh their masks after movement', async () => {
  await withScene(async s => {
    const first = s.element();
    const tooltip = s.tooltip();
    const second = s.element();
    await s.flush();
    expect(second.style.filter).toContain('url(');
    first.remove();
    await s.flush();
    expect(first.style.filter).toBe('');
    Object.defineProperty(tooltip.panel, 'getBoundingClientRect', {
      configurable: true, value: () => new s.window.DOMRect(300, 200, 180, 60),
    });
    s.window.dispatchEvent(new s.window.Event('resize'));
    await s.flush();
    expect(s.maskFor(second)).toContain('M308 200');
    tooltip.close();
    expect(second.style.filter).toBe('');
  });
});

test('tooltip blur clamps every source edge and corner without duplicating its interior, including after resize', async () => {
  await withScene(async s => {
    const app = s.element();
    const tooltip = s.tooltip(s.document.body, 610);
    const filter = s.filterFor(app);
    const rectangle = (element: { getAttribute(name: string): string | null }) => ['x', 'y', 'width', 'height'].map(name => Number(element.getAttribute(name)));
    const checkPadding = (width: number, height: number) => {
      expect(rectangle(filter)).toEqual([-48, -48, width + 96, height + 96]);
      const blur = filter.querySelector('feGaussianBlur')!;
      const merge = filter.querySelector('feMerge')!;
      expect(blur.getAttribute('in')).toBe(merge.getAttribute('result'));
      expect(merge.querySelectorAll('feMergeNode[in="SourceGraphic"]').length).toBe(1);
      expect(merge.children.length).toBe(9);
      const tiles = [...filter.querySelectorAll('feTile')];
      expect(tiles.length).toBe(8);
      for (const tile of tiles) {
        const [x, y, w, h] = rectangle(tile) as [number, number, number, number];
        expect(x + w <= 0 || y + h <= 0 || x >= width || y >= height).toBe(true);
        const crop = filter.querySelector(`feOffset[result="${tile.getAttribute('in')}"]`)!;
        expect(crop.getAttribute('in')).toBe('SourceGraphic');
        expect(rectangle(crop)).toEqual([
          x >= width ? width - 1 : 0, y >= height ? height - 1 : 0,
          x === 0 ? width : 1, y === 0 ? height : 1,
        ]);
      }
      expect(tiles.map(tile => rectangle(tile))).toEqual([
        [-48, -48, 48, 48], [0, -48, width, 48], [width, -48, 48, 48],
        [-48, 0, 48, height], [width, 0, 48, height],
        [-48, height, 48, 48], [0, height, width, 48], [width, height, 48, 48],
      ]);
      // The replacement mask still covers only the original source coordinates.
      expect(rectangle(filter.querySelector('feImage')!)).toEqual([0, 0, width, height]);
    };
    checkPadding(800, 600);
    Object.defineProperties(app, {
      offsetWidth: { configurable: true, value: 720 }, offsetHeight: { configurable: true, value: 480 },
      getBoundingClientRect: { configurable: true, value: () => new s.window.DOMRect(0, 0, 720, 480) },
    });
    s.window.dispatchEvent(new s.window.Event('resize'));
    await s.flush();
    checkPadding(720, 480);
    tooltip.close();
    expect(app.style.filter).toBe('');
    expect(s.document.querySelector('feTile')).toBeNull();
  });
});
