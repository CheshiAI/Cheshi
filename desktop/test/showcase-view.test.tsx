import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { SHOWCASE_URLS, safeShowcaseBackgroundColor, type ShowcaseApi, type ShowcasePage, type ShowcaseState, type ShowcaseViewRequest } from '../shared/showcase';
import type { ShowcaseView } from '../frontend/src/features/showcase/ShowcaseView';
import type { observeShowcaseViewport, showcaseViewportRequest } from '../frontend/src/features/showcase/showcaseViewport';

function compile(filename: string, globals: Record<string, unknown> = {}, modules: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(`../frontend/src/features/showcase/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, URL, ...globals,
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
  });
  return exports;
}

function createDeferred() {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, fail) => { reject = fail; });
  return { promise, reject };
}

function events() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(name: string, listener: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    emit(name: string) { for (const listener of listeners.get(name) ?? []) listener(); },
    count() { return [...listeners.values()].reduce((sum, value) => sum + value.size, 0); },
  };
}

function viewportHarness(setView?: ShowcaseApi['setView']) {
  const requests: ShowcaseViewRequest[] = [];
  const errors: unknown[] = [];
  let style = { display: 'block', visibility: 'visible' };
  let backgroundColor = '';
  let inert = false;
  let rect = { left: 100, top: 80, right: 900, bottom: 680 };
  const overlays: Array<{ style: typeof style; shown: boolean }> = [];
  const frames = new Map<number, () => void>();
  let frameId = 0;
  let now = 0;
  let resize!: () => void;
  let mutate!: () => void;
  let disconnected = 0;
  const window = { ...events(), visualViewport: events(), innerWidth: 1000, innerHeight: 800,
    getComputedStyle: (element: { style?: typeof style }) => ({ ...(element.style ?? style),
      getPropertyValue: (property: string) => property === '--app-bg' ? backgroundColor : '' }),
    requestAnimationFrame(callback: () => void) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  const document = { ...events(), body: {}, visibilityState: 'visible', querySelectorAll: () => overlays.map(value => ({
    isConnected: true, closest: () => null, getClientRects: () => value.shown ? [{}] : [], style: value.style,
  })) };
  const element = { isConnected: true, closest: () => inert ? {} : null,
    getClientRects: () => [{}], getBoundingClientRect: () => rect } as unknown as HTMLElement;
  const api: ShowcaseApi = { setView: async request => { requests.push(request); await setView?.(request); },
    navigate: async () => {}, onState: () => () => {} };
  const module = compile('showcaseViewport.ts', { window, document, performance: { now: () => now },
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() { disconnected += 1; } },
    MutationObserver: class { constructor(callback: () => void) { mutate = callback; } observe() {} disconnect() { disconnected += 1; } },
  }, { '../../../../shared/showcase': { safeShowcaseBackgroundColor } });
  return { requests, errors, overlays, window, document,
    measure: () => (module.showcaseViewportRequest as typeof showcaseViewportRequest)(element, 'submission'),
    observe: () => (module.observeShowcaseViewport as typeof observeShowcaseViewport)(element, api, 'submission', error => errors.push(error)),
    resize: () => resize(), mutate: () => mutate(), setInert: (value: boolean) => { inert = value; },
    setBackgroundColor: (value: string) => { backgroundColor = value; },
    setStyle: (value: typeof style) => { style = value; }, setRect: (value: typeof rect) => { rect = value; },
    flushFrame() { now += 16; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    pendingFrames: () => frames.size, disconnected: () => disconnected,
  };
}

test('native viewport uses CSS pixel bounds clipped to the visible window', () => {
  const harness = viewportHarness();
  expect(harness.measure()).toEqual({ page: 'submission', visible: true, bounds: { x: 100, y: 80, width: 800, height: 600 } });
  harness.setRect({ left: -10, top: 30, right: 1200, bottom: 950 });
  expect(harness.measure().bounds).toEqual({ x: 0, y: 30, width: 1000, height: 770 });
  harness.setRect({ left: 1200, top: 30, right: 1300, bottom: 200 });
  expect(harness.measure().visible).toBe(false);
});

test('viewport requests propagate the application background and update after theme changes', () => {
  const harness = viewportHarness();
  harness.setBackgroundColor('  #1E2025  ');
  const close = harness.observe();
  expect(harness.requests.at(-1)?.backgroundColor).toBe('#1E2025');
  harness.mutate();
  expect(harness.requests).toHaveLength(1);
  harness.setBackgroundColor('#FFFFFF');
  harness.mutate();
  expect(harness.requests).toHaveLength(2);
  expect(harness.requests.at(-1)?.backgroundColor).toBe('#FFFFFF');
  close();
  expect(harness.requests.at(-1)?.backgroundColor).toBe('#FFFFFF');
  expect(harness.requests.at(-1)?.visible).toBe(false);
  for (const value of ['', 'transparent', 'var(--other)', '#123', '#123456; color: red']) {
    harness.setBackgroundColor(value);
    expect(Object.hasOwn(harness.measure(), 'backgroundColor')).toBe(false);
  }
});

test('dialogs, menus and native popovers hide native content while closed or hidden surfaces do not', () => {
  const harness = viewportHarness();
  const close = harness.observe();
  harness.overlays.push({ shown: false, style: { display: 'none', visibility: 'visible' } });
  harness.mutate();
  expect(harness.requests).toHaveLength(1);
  harness.overlays[0] = { shown: true, style: { display: 'block', visibility: 'visible' } };
  harness.document.emit('toggle');
  expect(harness.requests.at(-1)?.visible).toBe(false);
  harness.overlays.splice(0);
  harness.mutate();
  expect(harness.requests.at(-1)?.visible).toBe(true);
  harness.setInert(true); harness.mutate();
  expect(harness.requests.at(-1)?.visible).toBe(false);
  harness.setInert(false); harness.setStyle({ display: 'block', visibility: 'hidden' }); harness.mutate();
  expect(harness.requests.at(-1)?.visible).toBe(false);
  harness.setStyle({ display: 'block', visibility: 'visible' }); harness.mutate();
  harness.document.visibilityState = 'hidden'; harness.document.emit('visibilitychange');
  expect(harness.requests.at(-1)?.visible).toBe(false);
  close();
});

test('resize, scrolling and layout transitions update bounds without duplicate requests and dispose every observer', () => {
  const harness = viewportHarness();
  const close = harness.observe();
  harness.resize(); harness.window.emit('resize'); harness.flushFrame();
  expect(harness.requests).toHaveLength(1);
  harness.setRect({ left: 100, top: 80, right: 700, bottom: 680 });
  harness.window.emit('scroll'); harness.flushFrame();
  expect(harness.requests.at(-1)?.bounds.width).toBe(600);
  harness.document.emit('transitionrun'); harness.flushFrame();
  expect(harness.pendingFrames()).toBe(1);
  close();
  expect(harness.pendingFrames()).toBe(0);
  expect(harness.disconnected()).toBe(2);
  expect(harness.window.count() + harness.window.visualViewport.count() + harness.document.count()).toBe(0);
  expect(harness.requests.at(-1)?.visible).toBe(false);
  const count = harness.requests.length;
  harness.mutate(); harness.resize(); harness.flushFrame();
  expect(harness.requests).toHaveLength(count);
});

test('obsolete viewport failures and failures after cleanup cannot replace the current state', async () => {
  const first = createDeferred();
  const next = createDeferred();
  let call = 0;
  const harness = viewportHarness(async () => { await (++call === 1 ? first.promise : next.promise); });
  const close = harness.observe();
  harness.setRect({ left: 100, top: 80, right: 700, bottom: 680 }); harness.mutate();
  first.reject(new Error('old'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(harness.errors).toEqual([]);
  close(); next.reject(new Error('closed'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(harness.errors).toEqual([]);
});

test('a current viewport request failure is reported for retry', async () => {
  const harness = viewportHarness(async () => { throw new Error('Bridge unavailable'); });
  const close = harness.observe();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(harness.errors).toHaveLength(1);
  expect((harness.errors[0] as Error).message).toBe('Bridge unavailable');
  close();
});

interface HookSlot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
interface ElementProps { children?: ReactNode; primary?: ReactNode; secondary?: ReactNode; 'aria-label'?: string;
  'aria-busy'?: boolean; ref?: { current: unknown }; onClick?: () => void; disabled?: boolean }
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.primary), ...elements(node.props.secondary)];
}
function control(node: ReactNode, label: string) {
  const element = elements(node).find(value => value.props['aria-label'] === label || value.props.children === label);
  assert.ok(element, `Missing control ${label}`);
  return element;
}

function viewHarness(available = true, navigate?: ShowcaseApi['navigate']) {
  const slots: HookSlot[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  const next = () => slots[cursor++] ??= {};
  const pages: ShowcasePage[] = [];
  const actions: string[] = [];
  let stopped = 0;
  let unsubscribed = 0;
  let handler: ((state: ShowcaseState) => void) | undefined;
  let viewportFailure: ((error: unknown) => void) | undefined;
  const api: ShowcaseApi = { setView: async () => {}, navigate: async action => { actions.push(action); await navigate?.(action); },
    onState(value) { handler = value; return () => { unsubscribed += 1; }; } };
  const module = compile('ShowcaseView.tsx', {}, {
    react: {
      useState(initial: unknown) { const slot = next(); if (!Object.hasOwn(slot, 'value')) slot.value = initial;
        return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
      useRef(initial: unknown) { return next().value ??= { current: initial }; },
      useLayoutEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
        const slot = next();
        if (slot.dependencies?.length === dependencies.length && dependencies.every((value, index) => Object.is(value, slot.dependencies![index]))) return;
        slot.dependencies = dependencies;
        effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() ?? undefined; });
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': Object.fromEntries(['ArrowLeft', 'ArrowRight', 'ExternalLink', 'House', 'PanelRight', 'PanelsTopLeft', 'RefreshCw'].map(name => [name, 'svg'])),
    '../../../../shared/showcase': { SHOWCASE_URLS },
    '../../cheshiDesktop': { cheshiDesktop: available ? { showcase: api } : undefined },
    '../../shared/errorMessage': { errorMessage: (value: Error) => value.message },
    '../../shared/ui': { NeumorphicButton: ({ children }: ElementProps) => <button>{children}</button>,
      LoadingState: ({ label }: { label: string }) => <div role="status" aria-label={label}>{label}</div>,
      TieredHeader: ({ primary, secondary }: ElementProps) => <header>{primary}{secondary}</header> },
    './showcaseViewport': { observeShowcaseViewport(_element: unknown, _api: ShowcaseApi, page: ShowcasePage, onError: (error: unknown) => void) {
      pages.push(page); viewportFailure = onError; return () => { stopped += 1; };
    } },
    './ShowcaseView.module.css': { default: {} },
  });
  const component = module.ShowcaseView as typeof ShowcaseView;
  return { pages, actions,
    render(active = true, blocked = false) {
      cursor = 0;
      const node = component({ active, blocked, rightSidebarOpen: true, onToggleRightSidebar() {} });
      for (const element of elements(node)) if (element.props.ref) element.props.ref.current = {};
      return node;
    },
    effects() { for (const effect of effects.splice(0)) effect(); },
    state(state: ShowcaseState) { handler?.(state); },
    viewportFailure(error: unknown) { viewportFailure?.(error); },
    close() { for (const slot of slots) slot.cleanup?.(); },
    stopped: () => stopped, unsubscribed: () => unsubscribed,
  };
}

const pageState = (page: ShowcasePage, url: string = SHOWCASE_URLS[page]): ShowcaseState => ({
  page, url, title: 'Example', loading: false, error: null, canGoBack: true, canGoForward: false,
});

test('shows the shared loader inside the content area until ready and on subsequent navigation', () => {
  const h = viewHarness();
  let node = h.render(); h.effects();
  const viewport = (tree: ReactNode) => elements(tree).find(element => element.props['aria-label'] === 'Showcase website');
  expect(renderToStaticMarkup(viewport(node)!)).toContain('Loading page…');
  expect(viewport(node)?.props['aria-busy']).toBe(true);
  h.state(pageState('gallery'));
  node = h.render();
  expect(renderToStaticMarkup(node)).not.toContain('Loading page…');
  expect(viewport(node)?.props['aria-busy']).toBe(false);
  h.state({ ...pageState('gallery'), loading: true });
  expect(renderToStaticMarkup(h.render())).toContain('Loading page…');
  h.state({ ...pageState('gallery'), loading: true, error: 'Page unavailable' });
  expect(renderToStaticMarkup(h.render())).not.toContain('Loading page…');
  control(h.render(), 'Submit project').props.onClick?.();
  node = h.render(); h.effects();
  expect(renderToStaticMarkup(node)).toContain('Loading page…');
  expect(renderToStaticMarkup(h.render(false))).not.toContain('Loading page…');
  expect(renderToStaticMarkup(h.render(true, true))).not.toContain('Loading page…');
  h.close();
});

test('Showcase opens lazily, retains the selected page across IDE navigation, and hides for blocking dialogs', () => {
  const harness = viewHarness();
  harness.render(false); harness.effects();
  expect(harness.pages).toEqual([]);
  let node = harness.render(); harness.effects();
  control(node, 'Submit project').props.onClick?.();
  node = harness.render(); harness.effects();
  expect(harness.pages).toEqual(['gallery', 'submission']);
  harness.render(false); harness.effects();
  harness.render(true, true); harness.effects();
  expect(harness.pages).toHaveLength(2);
  harness.render(); harness.effects();
  expect(harness.pages).toEqual(['gallery', 'submission', 'submission']);
  expect(harness.actions).toEqual([]);
  harness.close();
  expect(harness.stopped()).toBe(3);
  expect(harness.unsubscribed()).toBe(1);
});

test('page state keeps the actual origin and navigation controls separate between gallery and submission', () => {
  const harness = viewHarness();
  harness.render(); harness.effects();
  harness.state(pageState('gallery', 'https://demo.example.org/project'));
  let node = harness.render();
  expect(renderToStaticMarkup(node)).toContain('https://demo.example.org');
  expect(control(node, 'Go back').props.disabled).toBe(false);
  control(node, 'Go back').props.onClick?.();
  control(node, 'Submit project').props.onClick?.();
  node = harness.render(); harness.effects();
  expect(renderToStaticMarkup(node)).toContain('https://openai.com');
  expect(control(node, 'Go back').props.disabled).toBe(true);
  control(node, 'Open in browser').props.onClick?.();
  expect(harness.actions).toEqual(['back', 'external']);
  harness.close();
});

test('late navigation errors from a previous page are discarded', async () => {
  const pending = createDeferred();
  const harness = viewHarness(true, async () => { await pending.promise; });
  const node = harness.render(); harness.effects();
  control(node, 'Reload page').props.onClick?.();
  control(node, 'Submit project').props.onClick?.();
  harness.render(); harness.effects();
  pending.reject(new Error('Old navigation failed'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(renderToStaticMarkup(harness.render())).not.toContain('Old navigation failed');
  harness.close();
});

test('retry after bridge failure reattaches the viewport even before a native page exists', () => {
  const harness = viewHarness();
  harness.render(); harness.effects();
  harness.viewportFailure(new Error('Bridge unavailable'));
  let node = harness.render();
  expect(renderToStaticMarkup(node)).toContain('Bridge unavailable');
  control(node, 'Try again').props.onClick?.();
  harness.render(); harness.effects();
  node = harness.render();
  expect(harness.pages).toEqual(['gallery', 'gallery']);
  expect(harness.actions).toEqual([]);
  expect(renderToStaticMarkup(node)).not.toContain('Bridge unavailable');
  harness.close();
});

test('standalone viewer offers the official gallery and submission links without a desktop bridge', () => {
  const harness = viewHarness(false);
  let node = harness.render(); harness.effects();
  expect(renderToStaticMarkup(node)).toContain(`href="${SHOWCASE_URLS.gallery}"`);
  control(node, 'Submit project').props.onClick?.();
  node = harness.render(); harness.effects();
  expect(renderToStaticMarkup(node)).toContain(`href="${SHOWCASE_URLS.submission}"`);
  expect(harness.pages).toEqual([]);
  harness.close();
});
