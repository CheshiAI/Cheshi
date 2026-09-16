import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { StatusToastMessage, StatusToastProps } from '../frontend/src/shared/ui/StatusToast';

interface Element { type: unknown; props: Record<string, unknown> }
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

function harness() {
  let now = 0;
  let nextTimer = 0;
  let dependencies: unknown[] | undefined;
  let cleanup: (() => void) | undefined;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const ref = { current: undefined as unknown };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useRef: () => ref,
      useEffect(effect: () => () => void, values: unknown[]) {
        if (dependencies && values.every((value, index) => value === dependencies![index])) return;
        cleanup?.();
        dependencies = values;
        cleanup = effect();
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (node: unknown) => node },
    'lucide-react': { CircleCheck: 'CircleCheck', CircleAlert: 'CircleAlert', CircleX: 'CircleX', X: 'X' },
    './LiquidGlassPanel': { LiquidGlassPanel: 'Panel' },
    './NeumorphicButton': { NeumorphicButton: 'Button' },
    './StatusToast.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/shared/ui/StatusToast.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, document: { body: {} }, window: {
    setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  }, require(name: string) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`); return modules[name]; } });
  const component = exports.StatusToast;
  assert.ok(typeof component === 'function');
  return {
    render(props: StatusToastProps): Element { return component(props); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    unmount() { cleanup?.(); },
    get pending() { return timers.size; },
  };
}
const message: StatusToastMessage = { id: 1, variant: 'success', title: 'Keep awake enabled', description: 'Your Mac will stay awake.' };

test('dismisses after ten seconds and unrelated rerenders do not extend its lifetime', () => {
  const app = harness();
  let initial = 0;
  let current = 0;
  app.render({ message, onDismiss: () => { initial++; } });
  app.advance(5_000);
  app.render({ message, onDismiss: () => { current++; } });
  app.advance(4_999);
  expect(current).toBe(0);
  app.advance(1);
  expect(current).toBe(1);
  expect(initial).toBe(0);
  expect(app.pending).toBe(0);
});

test('a new message replaces the timer; unmounting cancels all callbacks', () => {
  const app = harness();
  let dismissals = 0;
  const onDismiss = () => { dismissals++; };
  app.render({ message, onDismiss }); app.advance(9_000);
  app.render({ message: { ...message, id: 2 }, onDismiss });
  expect(app.pending).toBe(1);
  app.advance(1_000); expect(dismissals).toBe(0);
  app.advance(8_999); expect(dismissals).toBe(0);
  app.advance(1); expect(dismissals).toBe(1);
  app.render({ message: { ...message, id: 3 }, onDismiss });
  app.unmount(); app.advance(10_000);
  expect(dismissals).toBe(1);
  expect(app.pending).toBe(0);
});

test('each status has an accessible announcement and manual close works without moving focus', () => {
  for (const variant of ['success', 'warning', 'error'] as const) {
    const app = harness();
    let closed = false;
    const tree = app.render({ message: { ...message, variant }, onDismiss: () => { closed = true; } });
    const nodes = elements(tree);
    expect(nodes.some(node => node.props.role === (variant === 'error' ? 'alert' : 'status'))).toBe(true);
    expect(nodes.some(node => node.type === { success: 'CircleCheck', warning: 'CircleAlert', error: 'CircleX' }[variant])).toBe(true);
    const close = nodes.find(node => node.props['aria-label'] === 'Close notification');
    assert.ok(typeof close?.props.onClick === 'function');
    close.props.onClick(); expect(closed).toBe(true);
    app.unmount(); expect(app.pending).toBe(0);
  }
});
