import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { ChatSavedTurnsSidebar } from '../frontend/src/features/chat/ChatSavedTurnsSidebar';
import type { SavedChatTurnsPanel } from '../frontend/src/features/chat/SavedChatTurnsPanel';
import type { SavedChatTurnsController } from '../frontend/src/features/chat/useSavedChatTurns';

function load<T>(file: string, name: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../frontend/src/features/chat/${file}.tsx`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled, { exports, require: (path: string) => {
    if (path === 'react') return React;
    if (path === 'react/jsx-runtime') return jsxRuntime;
    if (path.endsWith('.module.css')) return { default: {} };
    if (path === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (!Object.hasOwn(modules, path)) throw Error(`Unexpected dependency: ${path}`);
    return modules[path];
  } });
  return exports[name] as T;
}

function Button({ variant, size, active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string; size?: string; active?: boolean;
}) {
  return <button {...props} data-variant={variant} data-size={size} data-active={active} />;
}
const ui = {
  NeumorphicButton: Button,
  LoadingState: () => <span role="status">Loading</span>,
  SlidingSidePanel: ({ open, children }: { open: boolean; children: React.ReactNode }) => <div hidden={!open}>{children}</div>,
  Tooltip: ({ children }: { children: (props: Record<string, never>) => React.ReactNode }) => children({}),
};
const Panel = load<typeof SavedChatTurnsPanel>('SavedChatTurnsPanel', 'SavedChatTurnsPanel', {
  '../../shared/ui': ui,
  '../../shared/ui/TooltipButton': { TooltipButton: Button },
  '../../shared/ui/SidebarPanelHeader': { SidebarPanelTitle: () => <h2>Saved turns</h2> },
  './ChatDeleteRecordDialog': { ChatDeleteRecordDialog: () => null },
  './SavedChatTurnContent': { SavedChatTurnContent: () => null },
});
const Sidebar = load<typeof ChatSavedTurnsSidebar>('ChatSavedTurnsSidebar', 'ChatSavedTurnsSidebar', {
  '../../shared/ui': ui, './SavedChatTurnsPanel': { SavedChatTurnsPanel: Panel },
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function withSidebar(run: (h: {
  button(label: string): HTMLButtonElement;
  click(label: string): Promise<void>;
  escape(options?: { composing?: boolean; prevented?: boolean; target?: HTMLElement }): Promise<boolean>;
  finishRefresh(): Promise<void>;
  open(): boolean;
  outside(): HTMLInputElement;
}) => Promise<void>, error: string | null = null) {
  const window = new Window();
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const pending: ReturnType<typeof createDeferred>[] = [];
  function Host() {
    const [loading, setLoading] = React.useState(false);
    const savedTurns: SavedChatTurnsController = {
      records: [], error, loading, deleting: false, remove: async () => true, save: async () => true,
      isSaved: () => false, isSaving: () => false, dismissError: () => {},
      refresh: async () => {
        const gate = createDeferred();
        pending.push(gate);
        setLoading(true);
        await gate.promise;
        setLoading(false);
      },
    };
    return <><Sidebar savedTurns={savedTurns} /><input aria-label="Unrelated composer" /></>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const result = [...container.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent === label);
    if (!result) throw Error(`Missing button: ${label}`);
    return result;
  };
  const finishRefresh = async () => { await React.act(async () => { pending.splice(0).forEach(gate => gate.resolve()); }); };
  try {
    await React.act(async () => root.render(<Host />));
    await run({ button,
      click: async label => { await React.act(async () => { const target = button(label); target.focus(); target.click(); }); },
      escape: async ({ composing = false, prevented = false, target = document.activeElement as HTMLElement } = {}) => {
        const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: composing });
        if (prevented) event.preventDefault();
        await React.act(async () => target.dispatchEvent(event as unknown as Event));
        return event.defaultPrevented;
      },
      finishRefresh,
      open: () => button('Saved turns').getAttribute('aria-expanded') === 'true',
      outside: () => container.querySelector('input')!,
    });
  } finally {
    await finishRefresh();
    await React.act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('Escape closes from the rail immediately after opening and preserves opener focus', async () => {
  await withSidebar(async h => {
    await h.click('Saved turns');
    expect(h.open()).toBe(true);
    expect(document.activeElement).toBe(h.button('Saved turns'));
    expect(await h.escape()).toBe(true);
    expect(h.open()).toBe(false);
    expect(document.activeElement).toBe(h.button('Saved turns'));
    expect(await h.escape()).toBe(false);
  });
});

test.each(['Refresh saved turns', 'Retry'])('Escape works during and after %s without leaving focus on a disabled control', async label => {
  await withSidebar(async h => {
    await h.click('Saved turns');
    await h.finishRefresh();
    await h.click(label);
    expect(h.button(label).disabled).toBe(true);
    expect(document.activeElement).toBe(h.button('Close saved turns panel'));
    await h.escape();
    expect(h.open()).toBe(false);
    await h.finishRefresh();
    expect(document.activeElement).toBe(h.button('Saved turns'));
    await h.click('Saved turns');
    await h.finishRefresh();
    await h.click(label);
    await h.finishRefresh();
    expect(document.activeElement).toBe(h.button('Close saved turns panel'));
    await h.escape();
    expect(h.open()).toBe(false);
    expect(document.activeElement).toBe(h.button('Saved turns'));
  }, label === 'Retry' ? 'Could not load saved turns.' : null);
});

test('Escape respects composing and handled events and does not capture another composer', async () => {
  await withSidebar(async h => {
    await h.click('Saved turns');
    await h.escape({ composing: true });
    expect(h.open()).toBe(true);
    await h.escape({ prevented: true });
    expect(h.open()).toBe(true);
    h.outside().focus();
    expect(await h.escape({ target: h.outside() })).toBe(false);
    expect(h.open()).toBe(true);
    await h.click('Close saved turns panel');
    expect(h.open()).toBe(false);
    expect(document.activeElement).toBe(h.button('Saved turns'));
  });
});
