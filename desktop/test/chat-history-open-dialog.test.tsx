import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

interface Element {
  type: string;
  props: Record<string, unknown>;
}

const compiled = ts.transpileModule(readFileSync(new URL('../frontend/src/features/chat/ChatHistoryOpenDialog.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'props' in value && 'type' in value;
}

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}

function find(tree: Element, type: string, property?: [string, unknown]): Element {
  const result = elements(tree).find(element => element.type === type && (!property || element.props[property[0]] === property[1]));
  assert.ok(result, `Expected ${type} element`);
  return result;
}

function invoke(element: Element, property: string, ...args: unknown[]) {
  const callback = element.props[property];
  assert.equal(typeof callback, 'function');
  return (callback as (...values: unknown[]) => unknown)(...args);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function harness() {
  const hooks: unknown[] = [];
  let hookIndex = 0;
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const request = createDeferred<boolean>();
  const calls = { resume: 0, fork: [] as [string, string][], opened: 0, closed: 0, dismiss: 0 };
  const workspace = {
    splitPending: false,
    error: null as string | null,
    historyForkReason: () => null as string | null,
    dismissError: () => { calls.dismiss++; },
    forkHistorySession: (sessionId: string, paneId: string) => { calls.fork.push([sessionId, paneId]); return request.promise; },
  };
  const jsx = (type: string, props: Record<string, unknown>): Element => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = hookIndex++;
        if (index >= hooks.length) hooks[index] = initial;
        return [hooks[index], (value: unknown) => { hooks[index] = value; }];
      },
      useRef(initial: unknown) {
        const index = hookIndex++;
        if (index >= hooks.length) hooks[index] = { current: initial };
        return hooks[index];
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { GitFork: 'GitFork', History: 'History', MessageSquareText: 'MessageSquareText' },
    '../../shared/ui': { Modal: 'Modal', NeumorphicButton: 'Button', LoadingState: 'LoadingState' },
    './ChatSplitDialog.module.css': { default: new Proxy({}, { get: (_target, key) => String(key) }) },
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled, {
    exports, Error,
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
    window: {
      requestAnimationFrame(callback: () => void) { frames.push(callback); return frames.length; },
      setTimeout(callback: () => void) { timers.push(callback); return timers.length; },
    },
  });
  const component = exports.ChatHistoryOpenDialog;
  assert.equal(typeof component, 'function');
  const props = {
    workspace, sessionId: 'saved-session', sessionTitle: 'A saved conversation', paneId: 'main-pane',
    onResume: () => { calls.resume++; return request.promise; },
    onOpened: () => { calls.opened++; }, onClose: () => { calls.closed++; },
  };
  return {
    calls, request, workspace,
    render() {
      hookIndex = 0;
      const tree: unknown = (component as (value: typeof props) => unknown)(props);
      assert.ok(isElement(tree));
      return tree;
    },
    frame() { for (const callback of frames.splice(0)) callback(); },
    async afterPaint() { for (const callback of timers.splice(0)) callback(); await settle(); },
  };
}

async function settle() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function submit(tree: Element) {
  invoke(find(tree, 'form'), 'onSubmit', { preventDefault() {} });
}

function expectBusy(tree: Element, busy: boolean) {
  expect(find(tree, 'Modal').props.closeDisabled).toBe(busy);
  expect(find(tree, 'fieldset').props.disabled).toBe(busy);
  expect(find(tree, 'Button', ['type', 'button']).props.disabled).toBe(busy);
  expect(find(tree, 'Button', ['type', 'submit']).props.disabled).toBe(busy);
  expect(find(tree, 'Button', ['type', 'submit']).props['aria-busy']).toBe(busy);
  expect(elements(tree).some(element => element.type === 'LoadingState')).toBe(busy);
}

describe('opening a saved conversation', () => {
  for (const mode of ['resume', 'fork'] as const) {
    test(`${mode} shows progress before starting work and ignores duplicate submissions`, async () => {
      const app = harness();
      if (mode === 'fork') invoke(find(app.render(), 'input', ['value', 'fork']), 'onChange');
      const idle = app.render();
      expectBusy(idle, false);
      submit(idle);
      submit(idle);
      invoke(find(idle, 'Modal'), 'onClose');
      invoke(find(idle, 'Button', ['type', 'button']), 'onClick');
      expect(app.calls.closed).toBe(0);
      const pending = app.render();
      expectBusy(pending, true);
      const loader = find(pending, 'LoadingState');
      expect(loader.props.type).toBe(mode === 'fork' ? 'processing' : 'preparing');
      expect(loader.props.label).toBe(mode === 'fork' ? 'Creating fork…' : 'Opening conversation…');
      invoke(find(pending, 'Modal'), 'onClose');
      expect(app.calls.closed).toBe(0);
      expect(app.calls.resume + app.calls.fork.length).toBe(0);
      app.frame();
      await settle();
      expect(app.calls.resume + app.calls.fork.length).toBe(0);
      await app.afterPaint();
      expect(app.calls.resume).toBe(mode === 'resume' ? 1 : 0);
      expect(app.calls.fork).toEqual(mode === 'fork' ? [['saved-session', 'main-pane']] : []);
      submit(app.render());
      expect(app.calls.resume + app.calls.fork.length).toBe(1);
      expectBusy(app.render(), true);
      app.request.resolve(true);
      await settle();
      expect(app.calls.opened).toBe(1);
      expectBusy(app.render(), false);
      expect(invoke(find(app.render(), 'Modal'), 'restoreFocus')).toBe(false);
    });
  }

  for (const failure of ['false', 'rejection'] as const) {
    test(`${failure} removes progress and restores controls with an error`, async () => {
      const app = harness();
      submit(app.render());
      app.frame();
      await app.afterPaint();
      if (failure === 'false') app.request.resolve(false);
      else app.request.reject(new Error('Connection timed out'));
      await settle();
      const tree = app.render();
      expectBusy(tree, false);
      expect(find(tree, 'p', ['role', 'alert']).props.children).toBe(failure === 'false'
        ? 'Could not open the conversation. Please try again.' : 'Connection timed out');
      expect(app.calls.opened).toBe(0);
      expect(invoke(find(tree, 'Modal'), 'restoreFocus')).toBe(true);
      invoke(find(tree, 'Modal'), 'onClose');
      expect(app.calls.closed).toBe(1);
    });
  }

  test('an existing workspace split also exposes progress and blocks another open', async () => {
    const app = harness();
    app.workspace.splitPending = true;
    expectBusy(app.render(), true);
    submit(app.render());
    app.frame();
    await app.afterPaint();
    expect(app.calls.resume + app.calls.fork.length).toBe(0);
  });
});
