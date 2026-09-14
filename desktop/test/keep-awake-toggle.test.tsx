import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { KeepAwakeApi, KeepAwakeState } from '../shared/keep-awake';

interface Element { type: unknown; props: Record<string, unknown> }
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('type' in value) || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function find(tree: unknown, type: unknown) {
  const element = elements(tree).find(item => item.type === type);
  assert.ok(element, `Missing ${type}`);
  return element;
}
function click(tree: unknown) {
  const callback = find(tree, 'Button').props.onClick;
  assert.equal(typeof callback, 'function');
  (callback as () => void)();
}
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let count = 0; count < 8; count++) await Promise.resolve();
}
const off: KeepAwakeState = { supported: true, enabled: false, error: null };
const on: KeepAwakeState = { ...off, enabled: true };

function harness(overrides: Partial<KeepAwakeApi> = {}, missing = false) {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const cleanups: (() => void)[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let rendered = false;
  let disposed = false;
  let writesAfterUnmount = 0;
  let unsubscribed = false;
  let listener: ((value: KeepAwakeState) => void) | undefined;
  const requests: boolean[] = [];
  const api: KeepAwakeApi = {
    get: async () => off,
    set: async enabled => { requests.push(enabled); return { ...off, enabled }; },
    subscribe: callback => { listener = callback; return () => { unsubscribed = true; }; },
    ...overrides,
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useId: () => 'keep-awake-error',
      useState(initial: unknown) {
        const index = stateCursor++;
        if (index >= states.length) states[index] = initial;
        return [states[index], (value: unknown) => {
          if (disposed) writesAfterUnmount++;
          states[index] = value;
        }];
      },
      useRef(initial: unknown) {
        const index = refCursor++;
        refs[index] ??= { current: initial };
        return refs[index];
      },
      useEffect(effect: () => (() => void)) {
        if (!rendered) cleanups.push(effect());
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { CirclePlay: 'CirclePlay', CircleStop: 'CircleStop' },
    '../../cheshiDesktop': { cheshiDesktop: undefined },
    '../../shared/ui': { NeumorphicButton: 'Button', LiquidGlassPanel: 'Panel', nonDraggableWindowRegionStyle: {} },
    './KeepAwakeToggle.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/chrome/KeepAwakeToggle.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  } });
  const component = exports.KeepAwakeToggle;
  assert.ok(typeof component === 'function');
  return {
    requests,
    render() {
      stateCursor = 0;
      refCursor = 0;
      const tree: unknown = component({ api: missing ? undefined : api });
      rendered = true;
      return tree;
    },
    publish(state: KeepAwakeState) { assert.ok(listener); listener(state); },
    unmount() { cleanups.forEach(cleanup => cleanup()); disposed = true; },
    get unsubscribed() { return unsubscribed; },
    get writesAfterUnmount() { return writesAfterUnmount; },
  };
}

test('loads actual status, toggles on and off, and shows matching action icons', async () => {
  const app = harness();
  expect(find(app.render(), 'Button').props.disabled).toBe(true);
  await settle();
  expect(find(app.render(), 'Button').props['aria-pressed']).toBe(false);
  expect(find(app.render(), 'CirclePlay')).toBeDefined();
  click(app.render());
  await settle();
  expect(app.requests).toEqual([true]);
  expect(find(app.render(), 'Button').props['aria-pressed']).toBe(true);
  expect(find(app.render(), 'CircleStop')).toBeDefined();
  click(app.render());
  await settle();
  expect(app.requests).toEqual([true, false]);
  expect(find(app.render(), 'Button').props['aria-pressed']).toBe(false);
});

test('a newer process event wins over a late initial status snapshot', async () => {
  const snapshot = createDeferred<KeepAwakeState>();
  const app = harness({ get: () => snapshot.promise });
  app.render();
  app.publish(on);
  snapshot.resolve(off);
  await settle();
  expect(find(app.render(), 'Button').props['aria-pressed']).toBe(true);
});

test('pending mutation blocks duplicate clicks and newer process exit wins over its response', async () => {
  const response = createDeferred<KeepAwakeState>();
  let calls = 0;
  const app = harness({ set: () => { calls++; return response.promise; } });
  app.render();
  await settle();
  const tree = app.render();
  click(tree);
  click(tree);
  expect(calls).toBe(1);
  expect(find(app.render(), 'Button').props.disabled).toBe(true);
  app.publish({ ...off, error: 'caffeinate exited' });
  response.resolve(on);
  await settle();
  const result = app.render();
  expect(find(result, 'Button').props['aria-pressed']).toBe(false);
  expect(find(result, 'Panel').props.children).toBe('caffeinate exited');
  expect(find(result, 'Button').props.disabled).toBe(false);
});

test('failed start preserves off state and presents an accessible retryable error', async () => {
  const app = harness({ set: async () => { throw new Error('Cannot start caffeinate'); } });
  app.render();
  await settle();
  click(app.render());
  await settle();
  const tree = app.render();
  expect(find(tree, 'Button').props['aria-pressed']).toBe(false);
  expect(find(tree, 'Button').props.disabled).toBe(false);
  expect(find(tree, 'Button').props['aria-describedby']).toBe('keep-awake-error');
  expect(find(tree, 'Panel').props.role).toBe('alert');
  expect(find(tree, 'Panel').props.children).toBe('Cannot start caffeinate');
});

test('unsupported or missing runtime keeps the toggle disabled', async () => {
  for (const app of [harness({ get: async () => ({ ...off, supported: false }) }), harness({}, true)]) {
    app.render();
    await settle();
    const tree = app.render();
    expect(find(tree, 'Button').props.disabled).toBe(true);
    click(tree);
    expect(app.requests).toEqual([]);
  }
});

test('unmount unsubscribes and ignores late snapshots, events, and mutation results', async () => {
  const snapshot = createDeferred<KeepAwakeState>();
  const app = harness({ get: () => snapshot.promise });
  app.render();
  app.unmount();
  snapshot.resolve(on);
  app.publish(on);
  await settle();
  expect(app.unsubscribed).toBe(true);
  expect(app.writesAfterUnmount).toBe(0);

  const response = createDeferred<KeepAwakeState>();
  const other = harness({ set: () => response.promise });
  other.render();
  await settle();
  click(other.render());
  other.unmount();
  response.resolve(on);
  await settle();
  expect(other.writesAfterUnmount).toBe(0);
});
