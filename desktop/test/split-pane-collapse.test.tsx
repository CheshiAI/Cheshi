import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { SplitPaneLayoutProps } from '../frontend/src/shared/ui/SplitPaneLayout';

interface Element { type: unknown; props: Record<string, unknown> }
interface Effect { deps: unknown[] }
const source = ts.transpileModule(readFileSync(new URL('../frontend/src/shared/ui/SplitPaneLayout.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(axis: 'columns' | 'rows' = 'columns') {
  let size = 1001;
  let onResize: (() => void) | undefined;
  const state: unknown[] = [];
  const effects = new Map<number, Effect>();
  const pending: Array<() => void> = [];
  const commits: Array<[string, number]> = [];
  let index = 0;
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './SplitPaneLayout.module.css': { default: { split: 'split', region: 'region', separator: 'separator' } },
    react: {
      useCallback: (callback: unknown) => callback,
      useRef(initial: unknown) {
        const slot = index++;
        if (!(slot in state)) state[slot] = { current: initial };
        return state[slot];
      },
      useState(initial: unknown) {
        const slot = index++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (value: unknown) => { state[slot] = value; }];
      },
      useEffect(callback: () => void, deps: unknown[]) {
        const slot = index++;
        const previous = effects.get(slot);
        if (previous && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
        effects.set(slot, { deps });
        pending.push(callback);
      },
    },
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports,
    ResizeObserver: class {
      constructor(callback: () => void) { onResize = callback; }
      observe() {}
      disconnect() {}
    }, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.SplitPaneLayout;
  assert.ok(typeof component === 'function');
  const renderComponent = component;
  const props: SplitPaneLayoutProps = {
    layout: { type: 'split', id: 'root', axis, ratio: 0.35,
      first: { type: 'pane', paneId: 'editor' },
      second: { type: 'split', id: 'nested', axis: 'rows', ratio: 0.6,
        first: { type: 'pane', paneId: 'chat' }, second: { type: 'pane', paneId: 'terminal' } } },
    renderPane: paneId => paneId,
    onResizeSplit: (id, ratio) => { commits.push([id, ratio]); },
  };
  function render(collapsedPane?: 'first' | 'second') {
    index = 0;
    const element = renderComponent({ ...props, collapsedPane }) as Element;
    assert.ok(typeof element.type === 'function');
    const tree = element.type(element.props) as Element;
    (tree.props.ref as { current: unknown }).current = {
      getBoundingClientRect: () => ({ width: size, height: size, left: 0, top: 0 }),
    };
    while (pending.length) pending.shift()?.();
    return tree;
  }
  return { render, commits, resize(nextSize: number) { size = nextSize; onResize?.(); } };
}
function children(tree: Element): [Element, Element, Element] {
  const elements = tree.props.children as Element[];
  assert.equal(elements.length, 3);
  return elements as [Element, Element, Element];
}
function invoke(element: Element, event: string, value: unknown) {
  const handler = element.props[event];
  assert.ok(typeof handler === 'function');
  handler(value);
}

for (const axis of ['columns', 'rows'] as const) {
  test(`${axis}: a smaller window clamps pane sizes without replacing the preferred ratio`, () => {
    const app = harness(axis);
    app.render();
    app.resize(301);
    const narrow = app.render();
    expect(children(narrow)[1].props['aria-valuenow']).toBe(40);
    expect(app.commits).toEqual([]);
    app.resize(201);
    expect(children(app.render())[1].props['aria-valuenow']).toBe(50);
    app.resize(1001);
    expect(children(app.render())[1].props['aria-valuenow']).toBe(35);
    expect(app.commits).toEqual([]);
  });

  test(`${axis}: dragging commits only on release, cancellation preserves the saved ratio`, () => {
    const app = harness(axis);
    const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
    const event = (offset: number) => ({ button: 0, pointerId: 1, clientX: offset, clientY: offset,
      currentTarget: target, preventDefault() {}, stopPropagation() {} });
    let separator = children(app.render())[1];
    invoke(separator, 'onPointerDown', event(500.5));
    invoke(separator, 'onPointerMove', event(670.5));
    expect(app.commits).toEqual([]);
    invoke(separator, 'onPointerUp', event(670.5));
    expect(app.commits).toEqual([['root', 0.67]]);
    separator = children(app.render())[1];
    invoke(separator, 'onPointerDown', event(800.5));
    invoke(separator, 'onPointerCancel', event(800.5));
    expect(app.commits).toHaveLength(1);
    expect(children(app.render())[1].props['aria-valuenow']).toBe(35);
  });

  test(`${axis}: collapsing keeps both descendants, hides interaction, and restores the resized ratio`, () => {
    const app = harness(axis);
    let tree = app.render();
    const initialChildren = children(tree).filter(child => child.props.className === 'region')
      .map(child => child.props.children as Element);
    invoke(children(tree)[1], 'onKeyDown', {
      key: axis === 'columns' ? 'ArrowRight' : 'ArrowDown', preventDefault() {}, stopPropagation() {},
    });
    tree = app.render('first');
    const track = axis === 'columns' ? 'gridTemplateColumns' : 'gridTemplateRows';
    expect(tree.props.style).toEqual({ [track]: 'minmax(0, 0fr) 0px minmax(0, 1fr)' });
    const [first, separator, second] = children(tree);
    expect(first.props).toMatchObject({ inert: true, 'aria-hidden': true });
    expect(second.props.inert).toBe(false);
    expect(separator.props).toMatchObject({ inert: true, 'aria-hidden': true, tabIndex: -1 });
    for (const [index, region] of [first, second].entries()) {
      const child = region.props.children as Element;
      const original = initialChildren[index];
      assert.ok(original);
      expect(child.type).toBe(original.type);
      expect(child.props.layout).toBe(original.props.layout);
      expect(child.props.collapsedPane).toBeUndefined();
    }
    invoke(separator, 'onKeyDown', { key: 'End' });
    invoke(separator, 'onDoubleClick', {});
    invoke(separator, 'onPointerDown', { button: 0 });
    expect(app.commits).toHaveLength(1);
    tree = app.render();
    const style = tree.props.style as Record<string, string>;
    const restoredTracks = style[track];
    assert.ok(restoredTracks);
    const restoredRatio = Number(restoredTracks.match(/minmax\(0, ([\d.]+)fr\)/)?.[1]);
    expect(restoredRatio).toBeCloseTo(0.4);
    expect(children(tree)[1].props.tabIndex).toBe(0);
    expect(children(tree)[0].props.inert).toBe(false);
    tree = app.render('second');
    expect(tree.props.style).toEqual({ [track]: 'minmax(0, 1fr) 0px minmax(0, 0fr)' });
    expect(children(tree)[2].props).toMatchObject({ inert: true, 'aria-hidden': true });
  });
}
