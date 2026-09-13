import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

interface Element {
  type: string;
  props: Record<string, unknown>;
}

type Kind = 'session' | 'history' | 'turn';

const compiled = Object.fromEntries(['Session', 'Record'].map(kind => [kind, ts.transpileModule(
  readFileSync(new URL(`../frontend/src/features/chat/ChatDelete${kind}Dialog.tsx`, import.meta.url), 'utf8'),
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText]));

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

function harness(kind: Kind) {
  const hooks: unknown[] = [];
  let hookIndex = 0;
  const requests = [createDeferred<boolean>(), createDeferred<boolean>()];
  const calls = { deleted: 0, completed: 0, closed: 0 };
  const jsx = (type: string | ((props: Record<string, unknown>) => unknown), props: Record<string, unknown>): unknown =>
    typeof type === 'function' ? type(props) : { type, props };
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
    'lucide-react': { Trash2: 'Trash2' },
    '../../shared/ui': { Modal: 'Modal', NeumorphicButton: 'Button', LoadingState: 'LoadingState' },
    './ChatSplitDialog.module.css': { default: new Proxy({}, { get: (_target, key) => String(key) }) },
  };
  const exports: Record<string, unknown> = {};
  const variant = kind === 'session' ? 'Session' : 'Record';
  vm.runInNewContext(compiled[variant]!, {
    exports, Error,
    require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; },
  });
  const component = exports[`ChatDelete${variant}Dialog`];
  assert.equal(typeof component, 'function');
  const props = {
    sessionTitle: 'A synthetic conversation', recordTitle: 'A synthetic saved record', kind,
    reason: null as string | null, pending: false, error: null as string | null,
    onDelete() {
      const request = requests[calls.deleted++];
      assert.ok(request, 'Unexpected extra deletion');
      return request.promise;
    },
    onDeleted() { calls.completed++; },
    onClose() { calls.closed++; },
  };
  return {
    calls, requests, props,
    render() {
      hookIndex = 0;
      const tree: unknown = (component as (value: typeof props) => unknown)(props);
      assert.ok(isElement(tree));
      return tree;
    },
  };
}

async function settle() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function submit(tree: Element) {
  invoke(find(tree, 'form'), 'onSubmit', { preventDefault() {} });
}

function cancel(tree: Element) {
  return find(tree, 'Button', ['children', 'Cancel']);
}

function expectBusy(tree: Element, busy: boolean) {
  expect(find(tree, 'Modal').props.closeDisabled).toBe(busy);
  expect(cancel(tree).props.disabled).toBe(busy);
  expect(find(tree, 'Button', ['type', 'submit']).props.disabled).toBe(busy);
  expect(find(tree, 'Button', ['type', 'submit']).props['aria-busy']).toBe(busy);
  expect(elements(tree).some(element => element.type === 'LoadingState')).toBe(busy);
}

describe('delete dialog progress', () => {
  for (const kind of ['session', 'history', 'turn'] as const) {
    test(`${kind} keeps progress visible until deletion completes and blocks duplicate actions`, async () => {
      const app = harness(kind);
      const idle = app.render();
      expectBusy(idle, false);
      submit(idle);
      submit(idle);
      invoke(find(idle, 'Modal'), 'onClose');
      invoke(cancel(idle), 'onClick');
      expect(app.calls).toEqual({ deleted: 1, completed: 0, closed: 0 });
      expect(app.props.pending).toBe(false);
      const pending = app.render();
      expectBusy(pending, true);
      const loader = find(pending, 'LoadingState');
      expect(loader.props.type).toBe('processing');
      expect(loader.props.label).toBe(kind === 'session' ? 'Deleting chat…' : 'Deleting saved record…');
      submit(pending);
      invoke(find(pending, 'Modal'), 'onClose');
      invoke(cancel(pending), 'onClick');
      expect(app.calls).toEqual({ deleted: 1, completed: 0, closed: 0 });
      app.requests[0]!.resolve(true);
      await settle();
      expectBusy(app.render(), false);
      expect(app.calls).toEqual({ deleted: 1, completed: kind === 'session' ? 1 : 0, closed: kind === 'session' ? 0 : 1 });
    });

    for (const failure of ['false', 'rejection'] as const) {
      test(`${kind} releases progress after ${failure} and permits retry`, async () => {
        const app = harness(kind);
        submit(app.render());
        expectBusy(app.render(), true);
        if (failure === 'false') app.requests[0]!.resolve(false);
        else app.requests[0]!.reject(new Error('Deletion timed out'));
        await settle();
        const failed = app.render();
        expectBusy(failed, false);
        expect(find(failed, 'p', ['role', 'alert']).props.children).toBe(failure === 'rejection'
          ? 'Deletion timed out' : kind === 'session'
            ? 'Could not delete the conversation. Please try again.' : 'Could not delete the saved record. Please try again.');
        expect(app.calls).toEqual({ deleted: 1, completed: 0, closed: 0 });
        submit(failed);
        const retry = app.render();
        expectBusy(retry, true);
        expect(elements(retry).some(element => element.props.role === 'alert')).toBe(false);
        expect(app.calls.deleted).toBe(2);
        app.requests[1]!.resolve(true);
        await settle();
        expectBusy(app.render(), false);
        expect(app.calls.completed + app.calls.closed).toBe(1);
      });
    }

    test(`${kind} respects externally pending deletion and restores closing afterward`, () => {
      const app = harness(kind);
      app.props.pending = true;
      const pending = app.render();
      expectBusy(pending, true);
      submit(pending);
      invoke(find(pending, 'Modal'), 'onClose');
      invoke(cancel(pending), 'onClick');
      expect(app.calls).toEqual({ deleted: 0, completed: 0, closed: 0 });
      app.props.pending = false;
      const idle = app.render();
      expectBusy(idle, false);
      invoke(find(idle, 'Modal'), 'onClose');
      expect(app.calls.closed).toBe(1);
    });
  }

  test('a session deletion restriction prevents submission without showing progress', async () => {
    const app = harness('session');
    app.props.reason = 'This conversation is currently running.';
    const blocked = app.render();
    expect(find(blocked, 'p', ['role', 'alert']).props.children).toBe(app.props.reason);
    expect(find(blocked, 'Button', ['type', 'submit']).props.disabled).toBe(true);
    expect(find(blocked, 'Modal').props.closeDisabled).toBe(false);
    expect(elements(blocked).some(element => element.type === 'LoadingState')).toBe(false);
    submit(blocked);
    expect(app.calls.deleted).toBe(0);
    app.props.reason = null;
    submit(app.render());
    expectBusy(app.render(), true);
    expect(app.calls.deleted).toBe(1);
    app.requests[0]!.resolve(true);
    await settle();
    expect(app.calls.completed).toBe(1);
  });
});
