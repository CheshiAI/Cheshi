import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as contracts from '../shared/autopilot';
import type { AutopilotApi, AutopilotState } from '../shared/autopilot';
import type { AutopilotView } from '../frontend/src/features/autopilot/AutopilotView';

interface Slot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
interface Props { children?: ReactNode; primary?: ReactNode; secondary?: ReactNode; disabled?: boolean;
  ref?: { current: unknown }; onClick?: () => void; onSubmit?: (event: { preventDefault(): void }) => void;
  'aria-label'?: string; onChange?: (event: { target: { value: string } }) => void }
function Button({ children, disabled, onClick }: Props) {
  return <button disabled={disabled} onClick={onClick}>{children}</button>;
}
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.primary), ...elements(node.props.secondary)];
}
function button(tree: ReactNode, label: string) {
  const value = elements(tree).find(node => node.type === Button && renderToStaticMarkup(node).includes(label));
  if (!value) throw new Error(`Missing button ${label}`);
  return value;
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const idle: AutopilotState = { configured: true, phase: 'idle', url: '', title: '', goal: '', error: null, modelMs: 0, steps: [] };

function harness(options: { get?: Promise<AutopilotState>; start?: Promise<AutopilotState>; configured?: boolean; available?: boolean; saved?: boolean } = {}) {
  const slots: Slot[] = [];
  const effects: Array<() => void> = [];
  const requests: unknown[] = [];
  const exportsRequested: string[] = [];
  let cursor = 0;
  let handler: ((state: AutopilotState) => void) | undefined;
  let observed = 0;
  let hidden = 0;
  let stops = 0;
  const next = () => slots[cursor++] ??= {};
  const effect = (run: () => void | (() => void), dependencies: readonly unknown[]) => {
    const slot = next();
    if (slot.dependencies?.length === dependencies.length && dependencies.every((value, index) => Object.is(value, slot.dependencies![index]))) return;
    slot.dependencies = dependencies;
    effects.push(() => { slot.cleanup?.(); slot.cleanup = run() ?? undefined; });
  };
  const api: AutopilotApi = {
    getState: async () => options.get ?? { ...idle, configured: options.configured ?? true },
    start: async request => { requests.push(request); return options.start ?? { ...idle, ...request, phase: 'loading' }; },
    stop: async () => { stops += 1; return { ...idle, phase: 'stopped' }; },
    exportReport: async format => { exportsRequested.push(format); return options.saved ?? true; },
    setView: async () => {}, onState(callback) { handler = callback; return () => { handler = undefined; }; },
  };
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) { const slot = next(); if (!Object.hasOwn(slot, 'value')) slot.value = initial;
        return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
      useRef(initial: unknown) { return next().value ??= { current: initial }; }, useEffect: effect, useLayoutEffect: effect,
    },
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': { Navigation: 'svg', PanelRight: 'svg', Play: 'svg', Square: 'svg' },
    '../../../../shared/autopilot': contracts,
    '../../cheshiDesktop': { cheshiDesktop: options.available === false ? undefined : { autopilot: api } },
    '../../shared/errorMessage': { errorMessage: (value: Error) => value.message },
    '../../shared/nativeBrowserViewport': { nativeBrowserViewportRequest() {}, observeNativeBrowserViewport() {
      observed += 1; return () => { hidden += 1; };
    } },
    '../../shared/ui': { NeumorphicButton: Button, NeumorphicTextField: 'input', LiquidGlassPanel: 'aside',
      TieredHeader: ({ primary, secondary }: Props) => <header>{primary}{secondary}</header> },
    '../../shared/ui/BetaBadge': { BetaBadge: () => <span>beta</span> },
    './AutopilotView.module.css': { default: {} },
  };
  const resultSource = readFileSync(new URL('../frontend/src/features/autopilot/AutopilotResearchResults.tsx', import.meta.url), 'utf8');
  const resultExports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(resultSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports: resultExports, require: (name: string) => modules[name] });
  modules['./AutopilotResearchResults'] = resultExports;
  const source = readFileSync(new URL('../frontend/src/features/autopilot/AutopilotView.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require: (name: string) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  } });
  const component = exports.AutopilotView as typeof AutopilotView;
  return { requests, exportsRequested, resultsComponent: resultExports.AutopilotResearchResults,
    render(active = true, blocked = false) {
      cursor = 0;
      const props: ComponentProps<typeof AutopilotView> = { active, blocked, rightSidebarOpen: false, onToggleRightSidebar() {} };
      const tree = component(props);
      for (const node of elements(tree)) if (node.props.ref) node.props.ref.current = {};
      for (const run of effects.splice(0)) run();
      return tree;
    },
    emit(value: AutopilotState) { handler?.(value); },
    close() { for (const slot of slots) slot.cleanup?.(); },
    observed: () => observed, hidden: () => hidden, stops: () => stops,
  };
}

test('Autopilot starts a goal, exposes Stop while running, and preserves a newer state event over the start reply', async () => {
  const start = createDeferred<AutopilotState>();
  const h = harness({ start: start.promise });
  try {
    h.render(); await flush();
    let tree = h.render();
    expect(button(tree, 'Start').props.disabled).toBe(false);
    elements(tree).find(node => node.type === 'form')!.props.onSubmit?.({ preventDefault() {} });
    expect(h.requests).toEqual([{ url: 'https://en.wikipedia.org/wiki/DNA', goal: 'Reach the Wikipedia page for Manipuri pony.' }]);
    h.emit({ ...idle, phase: 'thinking', url: 'https://example.org/', modelMs: 300 });
    start.resolve({ ...idle, phase: 'loading' });
    await flush();
    tree = h.render();
    expect(renderToStaticMarkup(tree)).toContain('Choosing the next action');
    button(tree, 'Stop').props.onClick?.();
    await flush();
    expect(h.stops()).toBe(1);
    expect(renderToStaticMarkup(h.render())).toContain('Stopped');
  } finally { h.close(); }
});

test('search text reaches the runner and action progress keeps Stop available with the input disabled', async () => {
  const h = harness();
  try {
    h.render(); await flush();
    const input = elements(h.render()).find(node => node.props['aria-label'] === 'Search text')!;
    input.props.onChange?.({ target: { value: '  Manipuri pony  ' } });
    elements(h.render()).find(node => node.type === 'form')!.props.onSubmit?.({ preventDefault() {} });
    await flush();
    expect(h.requests[0]).toEqual({ url: 'https://en.wikipedia.org/wiki/DNA',
      goal: 'Reach the Wikipedia page for Manipuri pony.', searchText: 'Manipuri pony' });
    h.emit({ ...idle, phase: 'acting', steps: [{ url: 'https://example.org/', title: 'Search',
      decisionMs: 10, loadMs: 20, confidence: 1, action: 'Type: Manipuri pony' }] });
    const tree = h.render();
    expect(elements(tree).find(node => node.props['aria-label'] === 'Search text')!.props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain('Type: Manipuri pony');
    button(tree, 'Stop').props.onClick?.();
    await flush();
    expect(h.stops()).toBe(1);
  } finally { h.close(); }
});

test('missing keys disable Start, and switching pages or opening a modal hides the native viewport', async () => {
  const h = harness({ configured: false });
  try {
    h.render(false);
    expect(h.observed()).toBe(0);
    h.render(); await flush();
    expect(button(h.render(), 'Start').props.disabled).toBe(true);
    expect(renderToStaticMarkup(h.render())).toContain('TYPE_SAFE_AI');
    h.render(true, true);
    expect(h.hidden()).toBe(1);
    h.render();
    expect(h.observed()).toBe(2);
    h.render(false);
    expect(h.hidden()).toBe(2);
  } finally { h.close(); }
});

test('a late initial state cannot erase completed history and the standalone viewer cannot start runs', async () => {
  const get = createDeferred<AutopilotState>();
  const h = harness({ get: get.promise });
  try {
    h.render();
    h.emit({ ...idle, phase: 'completed', steps: [{ title: 'Target page', url: 'https://example.org/target',
      decisionMs: 150, loadMs: 250, confidence: 1 }], modelMs: 150 });
    get.resolve(idle);
    await flush();
    expect(renderToStaticMarkup(h.render())).toContain('Target page');
    expect(renderToStaticMarkup(h.render())).toContain('Goal reached');
  } finally { h.close(); }
  const standalone = harness({ available: false });
  try { expect(button(standalone.render(), 'Start').props.disabled).toBe(true); }
  finally { standalone.close(); }
});


test('Research starts with a bounded source target and disables mode changes while collecting', async () => {
  const h = harness();
  try {
    h.render(); await flush();
    button(h.render(), 'Research').props.onClick?.();
    elements(h.render()).find(node => node.props['aria-label'] === 'Source target')!.props.onChange?.({ target: { value: '11' } });
    expect(button(h.render(), 'Start').props.disabled).toBe(true);
    elements(h.render()).find(node => node.props['aria-label'] === 'Source target')!.props.onChange?.({ target: { value: '3' } });
    elements(h.render()).find(node => node.type === 'form')!.props.onSubmit?.({ preventDefault() {} });
    await flush();
    expect(h.requests).toEqual([{ url: 'https://www.google.com/', goal: 'Find primary sources about TypeSafe AI and the Jev model.',
      searchText: 'TypeSafe AI Jev', mode: 'research', targetSources: 3 }]);
    expect(button(h.render(), 'Navigate').props.disabled).toBe(true);
  } finally { h.close(); }
});

test('stopped research keeps its evidence visible and reports a failed export', async () => {
  const h = harness({ saved: false });
  try {
    h.render(); await flush();
    h.emit({ ...idle, mode: 'research', targetSources: 5, phase: 'stopped', sources: [{
      url: 'https://example.org/source', title: 'Primary source', accessedAt: '2026-09-17T00:00:00.000Z',
      evidence: 'The original source passage is preserved in this report.', confidence: 0.9,
    }], issues: [] });
    const tree = h.render();
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('Primary source');
    expect(markup).toContain('Collection is incomplete');
    expect(markup).toContain('The original source passage');
    const result = elements(tree).find(node => node.type === h.resultsComponent)!;
    const props = result.props as ComponentProps<typeof import('../frontend/src/features/autopilot/AutopilotResearchResults').AutopilotResearchResults>;
    props.onExport('csv');
    await flush();
    expect(h.exportsRequested).toEqual(['csv']);
    expect(renderToStaticMarkup(h.render())).toContain('Could not save the research report.');
  } finally { h.close(); }
});


test('exports save directly without presenting Save as controls', async () => {
  const h = harness();
  try {
    h.render(); await flush();
    h.emit({ ...idle, mode: 'research', phase: 'completed', targetSources: 1, issues: [], sources: [{
      url: 'https://example.org/source', title: 'Evidence', accessedAt: '2026-09-17T00:00:00.000Z',
      evidence: 'Original evidence passage from a primary source.', confidence: 1,
    }] });
    const exportFrom = () => {
      const result = elements(h.render()).find(node => node.type === h.resultsComponent)!;
      return result.props as ComponentProps<typeof import('../frontend/src/features/autopilot/AutopilotResearchResults').AutopilotResearchResults>;
    };
    exportFrom().onExport('csv'); await flush();
    expect(renderToStaticMarkup(h.render())).toContain('Saved to Downloads/Cheshi Research.');
    exportFrom().onExport('markdown'); await flush();
    expect(h.exportsRequested).toEqual(['csv', 'markdown']);
    const markup = renderToStaticMarkup(h.render());
    expect(markup).toContain('Saved to Downloads/Cheshi Research.');
    expect(markup).not.toContain('Save CSV as');
    expect(markup).not.toContain('Save Markdown as');
  } finally { h.close(); }
});
