import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as React from 'react';
import { act } from 'react';
import ts from 'typescript';
import type { CodeGraphIndexController } from '../frontend/src/features/graph/useCodeGraphIndex';
import { useGraphController } from '../frontend/src/features/graph/useGraphController';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

interface IndexApi {
  isCodeGraphIndexed(): Promise<unknown>;
  reindexCodeGraph(): Promise<unknown>;
}

function loadIndexHook(api: IndexApi, fetchMeta: () => Promise<Response>): () => CodeGraphIndexController {
  const source = readFileSync(new URL('../frontend/src/features/graph/useCodeGraphIndex.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, fetch: fetchMeta, require(name: string) {
    if (name === 'react') return React;
    assert.equal(name, '../../cheshiDesktop');
    return { cheshiDesktop: api };
  } });
  assert.equal(typeof exports.useCodeGraphIndex, 'function');
  return exports.useCodeGraphIndex as () => CodeGraphIndexController;
}

interface Harness {
  window: Window;
  index(): CodeGraphIndexController;
  button(label: string): HTMLButtonElement;
  click(label: string): Promise<void>;
  key(key: string, composing?: boolean): Promise<void>;
  show(visible: boolean): Promise<void>;
}

async function withIndex(run: (h: Harness) => Promise<void>, options: {
  indexed?: () => Promise<unknown>;
  reindex?: () => Promise<unknown>;
  meta?: () => Promise<Response>;
  visible?: boolean;
} = {}) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element,
    MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const useIndex = loadIndexHook({
    isCodeGraphIndexed: options.indexed ?? (async () => true),
    reindexCodeGraph: options.reindex ?? (async () => ({ reindexed: true })),
  }, options.meta ?? (async () => Response.json({ stats: { fileCount: 12, nodeCount: 34, edgeCount: 56 }, lastIndexed: 1000 })));
  const { createRoot } = await import('react-dom/client');
  const { GraphInspector } = await import('../frontend/src/features/graph/GraphInspector');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: CodeGraphIndexController;
  let setVisible!: (visible: boolean) => void;
  function Fixture() {
    current = useIndex();
    const graph = useGraphController(false);
    const [visible, updateVisible] = React.useState(options.visible ?? true);
    setVisible = updateVisible;
    return <>
      <output aria-label="Index startup state">{current.status.state === 'loading' ? 'waiting' : 'ready'}</output>
      {visible && <GraphInspector graph={graph} index={current} openWorkspaceFile={() => {}} />}
    </>;
  }
  const button = (label: string) => {
    const result = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(result, `Missing button: ${label}`);
    return result;
  };
  try {
    await act(async () => root.render(<Fixture />));
    await run({ window, button, index: () => current,
      async click(label) {
        const target = button(label);
        expect(target.disabled).toBe(false);
        await act(async () => { target.focus(); target.click(); });
      },
      async key(key, composing = false) {
        await act(async () => document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', {
          key, bubbles: true, cancelable: true, isComposing: composing,
        }) as unknown as Event));
      },
      async show(visible) { await act(async () => setVisible(visible)); },
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

test('index startup completes without the graph view and panel switches reuse the loaded status', async () => {
  let reads = 0;
  await withIndex(async h => {
    expect(document.querySelector('[aria-label="Index startup state"]')?.textContent).toBe('ready');
    expect(document.querySelector('[aria-label="CodeGraph tools"]')).toBeNull();
    await h.show(true);
    await h.click('CodeGraph index');
    const panel = document.querySelector('[aria-label="CodeGraph index status"]')!;
    expect(panel.textContent).toContain('Files12');
    expect(panel.textContent).toContain('Nodes34');
    expect(panel.textContent).toContain('Relationships56');
    expect(panel.querySelector('time')?.getAttribute('datetime')).toBe(new Date(1000).toISOString());
    await h.show(false);
    await h.show(true);
    expect(h.index().status.state).toBe('ready');
    expect(reads).toBe(1);
  }, { visible: false, indexed: async () => { reads++; return true; } });
});

test('index rail supports immediate Escape, close button, toggling and switching panels', async () => {
  await withIndex(async h => {
    const rail = h.button('CodeGraph index');
    const open = () => rail.getAttribute('aria-expanded') === 'true';
    const tools = document.querySelector('[aria-label="CodeGraph tools"]')!;
    await h.click('CodeGraph index');
    expect(open()).toBe(true);
    expect(rail.getAttribute('data-index-state')).toBe('ready');
    await h.key('Escape', true);
    expect(open()).toBe(true);
    await h.key('Escape');
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(rail);
    expect(tools.querySelector('[aria-hidden="true"][inert]')).not.toBeNull();
    await h.click('CodeGraph index');
    await h.click('Close CodeGraph index panel');
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(rail);
    await h.click('CodeGraph index');
    await h.click('CodeGraph index');
    expect(open()).toBe(false);
    await h.click('CodeGraph index');
    await h.click('Explore');
    expect(open()).toBe(false);
    expect(h.button('Explore').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[aria-label="CodeGraph index status"]')?.closest('[hidden]')).not.toBeNull();
  });
});

test('reindex remains busy across view switches and refreshes the metadata after completion', async () => {
  const pending = createDeferred<{ reindexed: true }>();
  let calls = 0;
  let reads = 0;
  await withIndex(async h => {
    await h.click('CodeGraph index');
    await h.click('Reindex CodeGraph');
    expect(h.button('Reindex CodeGraph').disabled).toBe(true);
    expect(h.index().reindexing).toBe(true);
    expect(document.querySelector('[aria-label="CodeGraph index status"]')?.textContent).toContain('INDEXING');
    await h.show(false);
    await h.show(true);
    expect(h.button('Reindex CodeGraph').disabled).toBe(true);
    await act(async () => pending.resolve({ reindexed: true }));
    await h.click('CodeGraph index');
    expect(h.button('Reindex CodeGraph').disabled).toBe(false);
    expect(document.querySelector('[aria-label="CodeGraph index status"]')?.textContent).toContain('Files2');
    expect(calls).toBe(1);
    expect(reads).toBe(2);
  }, { reindex: () => { calls++; return pending.promise; }, meta: async () => {
    reads++;
    return Response.json({ stats: { fileCount: reads, nodeCount: 2, edgeCount: 3 }, lastIndexed: 1000 });
  } });
});

test.each([false, 'true'])('missing or invalid indexed flag %s remains inspectable and resolves startup', async indexed => {
  let reads = 0;
  await withIndex(async h => {
    expect(h.index().status.state).toBe('not_indexed');
    expect(document.querySelector('[aria-label="Index startup state"]')?.textContent).toBe('ready');
    await h.click('CodeGraph index');
    expect(h.button('CodeGraph index').getAttribute('data-index-state')).toBe('disabled');
    expect(h.button('Reindex CodeGraph').disabled).toBe(true);
    expect(document.querySelector('[aria-label="CodeGraph index status"]')?.textContent).toContain('NOT INDEXED');
    expect(reads).toBe(0);
  }, { indexed: async () => indexed, meta: async () => { reads++; return Response.json({}); } });
});

test('failed metadata settles startup and an invalid reindex result is reported without claiming success', async () => {
  await withIndex(async h => {
    expect(h.index().status.state).toBe('error');
    expect(document.querySelector('[aria-label="Index startup state"]')?.textContent).toBe('ready');
    await h.click('CodeGraph index');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('503');
    await h.click('Reindex CodeGraph');
    expect(h.index().reindexing).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('invalid reindex response');
  }, { meta: async () => new Response('', { status: 503 }), reindex: async () => ({ reindexed: 'true' }) });
});
