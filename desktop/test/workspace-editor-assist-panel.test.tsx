import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceEditorAssistPanel } from '../frontend/src/features/editor/WorkspaceEditorAssistPanel';
import type { WorkspaceEditorAssistState } from '../frontend/src/features/editor/workspaceEditorAssistState';
import { RegionalBlur } from '../frontend/src/shared/ui/RegionalBlur';

async function withAssistant(run: (h: {
  source: HTMLElement; events: string[];
  render(state: WorkspaceEditorAssistState | null): Promise<HTMLElement | null>;
  move(x: number, width: number): Promise<void>;
  hide(hidden: boolean): Promise<void>;
  flush(): Promise<void>;
  pending(): number;
}) => Promise<void>) {
  const window = new Window();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.defineProperties(window, {
    requestAnimationFrame: { value: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; } },
    cancelAnimationFrame: { value: (id: number) => { frames.delete(id); } },
  });
  const globals = { window, document: window.document, navigator: window.navigator, ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const source = document.createElement('div');
  source.id = 'app';
  source.style.filter = 'brightness(0.9)';
  Object.defineProperties(source, {
    offsetWidth: { value: 1200 }, offsetHeight: { value: 900 },
    getBoundingClientRect: { value: () => new window.DOMRect(0, 0, 1200, 900) },
  });
  document.body.append(source);
  const root = createRoot(source);
  const sourceRef = { current: source };
  const events: string[] = [];
  let bounds = new window.DOMRect(100, 80, 800, 700);
  const flush = async () => {
    for (let i = 0; i < 3; i++) await act(async () => {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(i * 16);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  try {
    await run({ source, events, flush, pending: () => frames.size,
      render: async state => {
        await act(async () => root.render(<RegionalBlur sourceRef={sourceRef}>
          <div className="workspace-editor-stage">{state && <WorkspaceEditorAssistPanel state={state}
            onApplyEdit={() => events.push('apply')} onChooseAction={() => events.push('action')}
            onClose={() => events.push('close')} onOpenReference={() => events.push('open')}
            onRenameChange={value => events.push(`rename:${value}`)} onRenameSubmit={() => events.push('submit')}
            onSelectReference={index => events.push(`select:${index}`)} />}</div>
        </RegionalBlur>));
        const marker = source.querySelector('.workspace-editor-assist-bounds');
        const panel = document.querySelector<HTMLElement>('.workspace-editor-assist');
        if (marker && panel) {
          Object.defineProperties(marker, {
            getBoundingClientRect: { configurable: true, value: () => bounds },
            getClientRects: { configurable: true, value: () => [bounds] },
          });
          panel.style.cssText = 'display:flex;visibility:visible;opacity:1;border-radius:12px';
          const panelBounds = () => new window.DOMRect(bounds.right - Math.min(680, bounds.width - 32) - 16,
            bounds.y + 16, Math.min(680, bounds.width - 32), 220);
          Object.defineProperties(panel, {
            getBoundingClientRect: { configurable: true, value: panelBounds },
            getClientRects: { configurable: true, value: () => [panelBounds()] },
          });
        }
        await flush();
        return panel;
      },
      move: async (x, width) => { bounds = new window.DOMRect(x, 80, width, 700); await flush(); },
      hide: async hidden => { source.querySelector<HTMLElement>('.workspace-editor-stage')!.hidden = hidden; await flush(); },
    });
  } finally {
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const states: WorkspaceEditorAssistState[] = [
  { kind: 'references', locations: [], selectedIndex: 0, preview: null, previewLoading: false },
  { kind: 'actions', actions: [], loading: false, error: null },
  { kind: 'rename', value: 'segments', placeholder: 'Name', submitting: false },
  { kind: 'edit-preview', title: 'Rename', files: [], applying: false },
];

test.each(states)('editor assistant $kind uses the shared SVG region outside its background source', async state => {
  await withAssistant(async h => {
    const panel = (await h.render(state))!;
    expect(h.source.contains(panel)).toBe(false);
    expect(panel.style.filter).toBe('');
    expect(panel.getAttribute('data-regional-blur-surface')).toBe('true');
    const filter = document.getElementById(h.source.getAttribute('data-regional-blur-source')!)!;
    expect(filter.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    expect(filter.querySelector('feImage')?.getAttribute('href')).toContain('M216%2096');
    const portal = panel.closest<HTMLElement>('.workspace-editor-assist-portal')!;
    expect(portal.style.left).toBe('100px');
    expect(portal.style.width).toBe('800px');
    await h.move(400, 500);
    expect(portal.style.left).toBe('400px');
    expect(portal.style.width).toBe('500px');
    expect(filter.querySelector('feImage')?.getAttribute('href')).toContain('M428%2096');
    await h.hide(true);
    expect(portal.hidden).toBe(true);
    expect(h.source.style.filter).toBe('brightness(0.9)');
    await h.hide(false);
    expect(portal.hidden).toBe(false);
    expect(document.querySelector('.workspace-editor-assist')).toBe(panel);
    expect(h.source.style.filter).toContain('url(');
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Close editor assistant"]')!.click());
    expect(h.events).toEqual(['close']);
    await h.render(null);
    expect(document.querySelector('.workspace-editor-assist-portal')).toBeNull();
    expect(h.source.style.filter).toBe('brightness(0.9)');
    expect(h.pending()).toBe(0);
  });
});

test('portaled assistant preserves rename focus, submit, clear, and Escape', async () => {
  await withAssistant(async h => {
    const panel = (await h.render(states[2]!))!;
    const input = panel.querySelector('input')!;
    expect(document.activeElement).toBe(input);
    await h.move(400, 500);
    expect(document.activeElement).toBe(input);
    await act(async () => panel.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Clear symbol name"]')!.click());
    await h.flush();
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(h.events).toEqual(['submit', 'rename:', 'close']);
  });
});

test('code actions retain disabled behavior and synchronize the overlay scrollbar', async () => {
  await withAssistant(async h => {
    const panel = (await h.render({ kind: 'actions', loading: false, error: null, actions: [
      { title: 'Extract constant', kind: 'refactor.extract', preferred: true, disabledReason: null, edit: { files: [] } },
      { title: 'Add braces', kind: 'refactor', preferred: false, disabledReason: 'Select an arrow function', edit: null },
    ] }))!;
    const viewport = panel.querySelector<HTMLElement>('[role="region"][aria-label="Quick fixes and refactorings"]')!;
    const scrollbar = viewport.nextElementSibling as HTMLElement;
    viewport.scrollTop = 84;
    viewport.dispatchEvent(new window.Event('scroll'));
    expect(scrollbar.scrollTop).toBe(84);
    scrollbar.scrollTop = 126;
    scrollbar.dispatchEvent(new window.Event('scroll'));
    expect(viewport.scrollTop).toBe(126);
    const buttons = viewport.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons[1]!.disabled).toBe(true);
    await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
    expect(h.events).toEqual(['action']);
    await h.render(null);
    viewport.scrollTop = 42;
    viewport.dispatchEvent(new window.Event('scroll'));
    expect(scrollbar.scrollTop).toBe(126);
  });
});
