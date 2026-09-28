import { expect, mock, test } from 'bun:test';
import { act, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Window, type HTMLElement as TestElement } from 'happy-dom';
import { RegionalBlur } from '../frontend/src/shared/ui/RegionalBlur';
import { LiquidGlassPanel } from '../frontend/src/shared/ui/LiquidGlassPanel';
import { LiquidGlassSelect } from '../frontend/src/shared/ui/LiquidGlassSelect';
import { Tooltip } from '../frontend/src/shared/ui/Tooltip';
import { ChatUserInputPrompt } from '../frontend/src/features/chat/ChatUserInputPrompt';
import { regionalBlurMask } from '../frontend/src/shared/ui/regionalBlurGeometry';

mock.module('../frontend/src/shared/ui/Tooltip.module.css', () => ({
  default: { anchor: 'tooltip-anchor', content: 'tooltip-content' },
}));

function Fixture({ portal, thread = 'one', menu = true, composer = true, nested = false, layered = false, select = false, mcp = false, tooltip = false }: {
  portal: HTMLElement; thread?: string; menu?: boolean; composer?: boolean; nested?: boolean; layered?: boolean; select?: boolean; mcp?: boolean; tooltip?: boolean;
}) {
  const sourceRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const panelStyle = { display: 'block', visibility: 'visible', opacity: 1, borderRadius: '16px' } as const;
  const popup = createPortal(<div><LiquidGlassPanel role="menu"
    data-box={layered ? '350,470,200,60' : '350,250,200,180'} style={panelStyle}>
    <button role="menuitem">Model</button>
  </LiquidGlassPanel></div>, portal);
  const scene = <>
    <section key={thread} ref={sourceRef} data-source="true" data-box="100,50,600,500">
      <p>Conversation stays sharp outside the surface.</p>
      {tooltip && <Tooltip content="Conversation history" delay={0} blurSourceRef={sourceRef}>
        {trigger => <button {...trigger} aria-label="History">History</button>}
      </Tooltip>}
      {nested && <LiquidGlassPanel role="listbox" data-box="120,70,100,50" style={panelStyle}>Inline options</LiquidGlassPanel>}
    </section>
    {composer && <div ref={composerRef} data-composer-layer="true" data-box="120,450,550,80" style={{ filter: 'brightness(1)' }}>
      <LiquidGlassPanel data-liquid-glass-backdrop="true" data-composer="true"
      data-box="120,450,550,80" style={panelStyle}><textarea defaultValue="Keep this draft" />
        {mcp && <ChatUserInputPrompt menuBlurSourceRef={composerRef} pending={false} error={null}
          respond={async () => true} request={{ kind: 'form', id: 'request', threadId: 'thread', turnId: null,
            serverName: 'Test', message: 'Choose whether to proceed', fields: [{ name: 'proceed', title: 'Proceed',
              description: '', type: 'boolean', required: true }] }} />}
        {select && <LiquidGlassSelect ariaLabel="Permissions" menuAppearance="toolbar" triggerAppearance="standard"
          menuBlurSourceRef={composerRef} value="read-only" options={[{ value: 'read-only', label: 'Read only' }]}
          onChange={() => {}} />}
      </LiquidGlassPanel></div>}
    {menu && (layered ? <RegionalBlur sourceRef={composerRef}>{popup}</RegionalBlur> : popup)}
  </>;
  return tooltip ? scene : <RegionalBlur sourceRef={sourceRef}>{scene}</RegionalBlur>;
}

async function withDOM(run: (h: {
  render: (props?: Partial<Parameters<typeof Fixture>[0]>) => Promise<void>;
  document: Document; flush: () => Promise<void>; invalidate: () => void;
  observerCount: () => number; unmount: () => Promise<void>;
}) => Promise<void>) {
  const window = new Window();
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.defineProperties(window, {
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame; } },
    cancelAnimationFrame: { configurable: true, value: (id: number) => { callbacks.delete(id); } },
  });
  const observers = new Set<Observer>();
  class Observer {
    active = false;
    constructor(readonly callback: () => void) { observers.add(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  Object.defineProperties(window, {
    ResizeObserver: { configurable: true, value: Observer },
    MutationObserver: { configurable: true, value: Observer },
  });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: Observer, MutationObserver: Observer, getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const box = (element: TestElement) => {
    const [x = 0, y = 0, width = 0, height = 0] = (element.dataset.box ?? '').split(',').map(Number);
    return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON() { return {}; } };
  };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get(this: TestElement) { return box(this).width; } },
    offsetHeight: { configurable: true, get(this: TestElement) { return box(this).height; } },
    getBoundingClientRect: { configurable: true, value(this: TestElement) { return box(this); } },
    getClientRects: { configurable: true, value(this: TestElement) { return this.hidden ? [] : [box(this)]; } },
  });
  const container = window.document.createElement('div'), portal = window.document.createElement('div');
  window.document.body.append(container, portal);
  const root = createRoot(container as unknown as HTMLElement);
  let mounted = true;
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  try {
    await run({
      render: async props => { await act(async () => root.render(<Fixture portal={portal as unknown as HTMLElement} {...props} />)); },
      document: window.document as unknown as Document,
      invalidate: () => { for (const observer of observers) if (observer.active) observer.callback(); },
      flush: async () => { await act(async () => {
        const pending = [...callbacks.values()]; callbacks.clear();
        for (const callback of pending) callback(0);
      }); },
      observerCount: () => [...observers].filter(observer => observer.active).length,
      unmount,
    });
  } finally {
    await unmount();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function mask(document: Document) {
  return decodeURIComponent(document.querySelector('feImage')?.getAttribute('href')?.split(',').slice(1).join(',') ?? '');
}

test('portal menus and composer share a source while inline foregrounds stay outside registration', async () => {
  await withDOM(async h => {
    await h.render({ nested: true });
    expect(h.document.querySelectorAll('[data-regional-blur-surface="true"]').length).toBe(2);
    expect(h.document.querySelector('[role="listbox"]')?.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(mask(h.document).match(/<path /g)?.length).toBe(2);
    expect(h.document.querySelector<HTMLElement>('[data-source]')?.style.filter).toContain('url(');
    expect(h.document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep this draft');
    expect(h.document.querySelector<HTMLElement>('[role="menu"]')?.style.filter).toBe('');
    expect(mask(h.document)).toContain('M266 200');
  });
});

test('viewport mask follows menu movement and viewport resizing, not the conversation scroll offset', async () => {
  await withDOM(async h => {
    await h.render();
    const before = mask(h.document);
    const source = h.document.querySelector<HTMLElement>('[data-source]')!;
    source.scrollTop = 700;
    h.invalidate(); await h.flush();
    expect(mask(h.document)).toBe(before);
    h.document.querySelector<HTMLElement>('[role="menu"]')!.dataset.box = '420,210,200,180';
    h.invalidate(); await h.flush();
    expect(mask(h.document)).toContain('M336 160');
    source.dataset.box = '200,50,500,400';
    h.invalidate(); await h.flush();
    expect(h.document.querySelector('filter')?.getAttribute('width')).toBe('500');
    expect(mask(h.document)).toContain('M236 160');
  });
});

test('closing, hiding, and reopening surfaces removes stale masks and disconnects on unmount', async () => {
  await withDOM(async h => {
    await h.render();
    await h.render({ menu: false });
    expect(mask(h.document).match(/<path /g)?.length).toBe(1);
    const composer = h.document.querySelector<HTMLElement>('[data-composer]')!;
    composer.hidden = true; h.invalidate(); await h.flush();
    expect(mask(h.document)).toBe('');
    expect(h.document.querySelector<HTMLElement>('[data-source]')!.style.filter).toBe('');
    composer.hidden = false; h.invalidate(); await h.flush();
    expect(mask(h.document).match(/<path /g)?.length).toBe(1);
    await h.render({ menu: false, composer: false });
    expect(mask(h.document)).toBe('');
    await h.unmount();
    expect(h.observerCount()).toBe(0);
    expect(h.document.querySelector('[data-regional-blur-surface]')).toBeNull();
  });
});

test('a conversation switch reconnects the replacement timeline and restores the detached source', async () => {
  await withDOM(async h => {
    await h.render();
    const oldSource = h.document.querySelector<HTMLElement>('[data-source]')!;
    await h.render({ thread: 'two' });
    const newSource = h.document.querySelector<HTMLElement>('[data-source]')!;
    expect(newSource).not.toBe(oldSource);
    expect(oldSource.style.filter).toBe('');
    expect(oldSource.hasAttribute('data-regional-blur-source')).toBe(false);
    expect(newSource.style.filter).toContain('url(');
    expect(mask(h.document).match(/<path /g)?.length).toBe(2);
  });
});

test('a nested menu blurs both scene and composer footprints, then restores the composer on close', async () => {
  await withDOM(async h => {
    await h.render({ layered: true });
    const composer = h.document.querySelector<HTMLElement>('[data-composer-layer]')!;
    const menu = h.document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(composer.style.filter).toContain('url(');
    expect(h.document.querySelector<HTMLElement>('[data-source]')!.style.filter).toContain('url(');
    expect(mask(h.document).match(/<path /g)?.length).toBe(2);
    const filter = h.document.getElementById(composer.getAttribute('data-regional-blur-source')!)!;
    const localMask = decodeURIComponent(filter.querySelector('feImage')!.getAttribute('href')!.split(',').slice(1).join(','));
    expect(localMask.match(/<path /g)?.length).toBe(1);
    expect(localMask).toContain('M246 20');
    expect(filter.getAttribute('width')).toBe('550');
    expect(menu.style.filter).toBe('');
    expect(h.document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this draft');
    await h.render({ layered: true, menu: false });
    expect(composer.style.filter).toBe('brightness(1)');
    expect(composer.hasAttribute('data-regional-blur-source')).toBe(false);
    expect(menu.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(mask(h.document).match(/<path /g)?.length).toBe(1);
    await h.render({ layered: true });
    expect(composer.style.filter).toContain('url(');
    await h.unmount();
    expect(composer.style.filter).toBe('brightness(1)');
    expect(h.observerCount()).toBe(0);
  });
});

test('disconnecting one backdrop preserves the menu registration owned by the remaining scene', async () => {
  await withDOM(async h => {
    await h.render({ layered: true });
    const composer = h.document.querySelector<HTMLElement>('[data-composer-layer]')!;
    const menu = h.document.querySelector<HTMLElement>('[role="menu"]')!;
    await h.render({ layered: true, composer: false });
    expect(composer.style.filter).toBe('brightness(1)');
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(mask(h.document).match(/<path /g)?.length).toBe(1);
    await h.render({ layered: true, composer: false, menu: false });
    expect(menu.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(h.document.querySelector<HTMLElement>('[data-source]')!.style.filter).toBe('');
  });
});

test('a select connects its composer backdrop only while the popup is open and restores focus on dismissal', async () => {
  await withDOM(async h => {
    await h.render({ menu: false, select: true });
    const composer = h.document.querySelector<HTMLElement>('[data-composer-layer]')!;
    const trigger = h.document.querySelector<HTMLButtonElement>('[aria-label="Permissions"]')!;
    expect(composer.style.filter).toBe('brightness(1)');
    await act(async () => trigger.click());
    const menu = h.document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.dataset.box = '350,470,200,60';
    menu.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:16px';
    h.invalidate(); await h.flush();
    expect(composer.style.filter).toContain('url(');
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(menu.style.filter).toBe('');
    expect(mask(h.document).match(/<path /g)?.length).toBe(2);
    await act(async () => menu.dispatchEvent(new h.document.defaultView!.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })));
    expect(h.document.querySelector('[role="menu"]')).toBeNull();
    expect(h.document.activeElement).toBe(trigger);
    expect(composer.style.filter).toBe('brightness(1)');
    expect(menu.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(h.document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this draft');
    expect(mask(h.document).match(/<path /g)?.length).toBe(1);
  });
});

test('mask clips offscreen surfaces and maps scaled coordinates with independently rounded corners', () => {
  const bounds = { x: 100, y: 100, width: 400, height: 400 };
  const surface = { x: 80, y: 400, width: 240, height: 200, corners: ['0', '0', '16px', '16px'] as const };
  const svg = regionalBlurMask(bounds, 200, 200, [surface]);
  expect(svg).toContain('M-10 150H110A0 0');
  expect(svg).toContain('A16 16');
  expect(regionalBlurMask(bounds, 200, 200, [{ ...surface, x: 500 }])).toBeNull();
  expect(regionalBlurMask({ ...bounds, width: 0 }, 0, 200, [surface])).toBeNull();
});


test('an explicitly connected tooltip blurs its workspace and restores it on dismissal and unmount', async () => {
  await withDOM(async h => {
    await h.render({ menu: false, composer: false, tooltip: true });
    const source = h.document.querySelector<HTMLElement>('[data-source]')!;
    const trigger = h.document.querySelector<HTMLButtonElement>('[aria-label="History"]')!;
    const open = async () => {
      await act(async () => trigger.dispatchEvent(new h.document.defaultView!.PointerEvent('pointerover', {
        bubbles: true, pointerType: 'mouse',
      })));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      const tooltip = h.document.querySelector<HTMLElement>('[role="tooltip"]')!;
      tooltip.dataset.box = '350,250,200,60';
      tooltip.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:8px';
      h.invalidate(); await h.flush();
      expect(source.contains(tooltip)).toBe(false);
      expect(source.style.filter).toContain('url(');
      expect(tooltip.getAttribute('data-regional-blur-surface')).toBe('true');
      expect(tooltip.style.filter).toBe('');
      expect(tooltip.textContent).toBe('Conversation history');
      return tooltip;
    };
    expect(source.style.filter).toBe('');
    const tooltip = await open();
    await act(async () => h.document.dispatchEvent(new h.document.defaultView!.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true,
    })));
    expect(h.document.querySelector('[role="tooltip"]')).toBeNull();
    expect(source.style.filter).toBe('');
    expect(tooltip.hasAttribute('data-regional-blur-surface')).toBe(false);
    await open();
    await h.unmount();
    expect(source.style.filter).toBe('');
    expect(h.observerCount()).toBe(0);
  });
});

test('MCP form menus include the composer backdrop and preserve answers and drafts after closing', async () => {
  await withDOM(async h => {
    await h.render({ menu: false, mcp: true });
    const composer = h.document.querySelector<HTMLElement>('[data-composer-layer]')!;
    const trigger = h.document.querySelector<HTMLButtonElement>('[aria-label="Proceed"]')!;
    expect(composer.style.filter).toBe('brightness(1)');
    await act(async () => trigger.click());
    const menu = h.document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.dataset.box = '350,470,200,60';
    menu.style.cssText = 'display:block;visibility:visible;opacity:1;border-radius:16px';
    h.invalidate(); await h.flush();
    expect(composer.style.filter).toContain('url(');
    expect(h.document.querySelector<HTMLElement>('[data-source]')!.style.filter).toContain('url(');
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(menu.style.filter).toBe('');
    const yes = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === 'Yes')!;
    await act(async () => yes.click());
    expect(h.document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.textContent).toBe('Yes');
    expect(h.document.activeElement).toBe(trigger);
    expect(composer.style.filter).toBe('brightness(1)');
    expect(menu.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(h.document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this draft');
    await h.unmount();
    expect(h.observerCount()).toBe(0);
  });
});
