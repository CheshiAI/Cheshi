import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { KeepAwakeApi, KeepAwakeState } from '../shared/keep-awake';

interface Element { type: unknown; props: Record<string, unknown> }
const off: KeepAwakeState = { supported: true, enabled: false, busy: false, error: null, revision: 0 };
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 6; index++) await Promise.resolve(); }

function harness(overrides: Partial<KeepAwakeApi> & { platform?: string } = {}) {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const cleanups: (() => void)[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let mounted = false;
  let unsubscribed = false;
  let listener: ((state: KeepAwakeState) => void) | undefined;
  const calls: boolean[] = [];
  const api = { platform: 'darwin',
    getKeepAwake: async () => off,
    setKeepAwake: async (enabled: boolean) => { calls.push(enabled); return { ...off, enabled, revision: calls.length }; },
    onKeepAwakeChanged: (callback: (state: KeepAwakeState) => void) => {
      listener = callback;
      return () => { unsubscribed = true; };
    }, ...overrides };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: {
      useState(initial: unknown) {
        const index = stateCursor++;
        if (index >= states.length) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useRef(initial: unknown) { const index = refCursor++; return refs[index] ??= { current: initial }; },
      useEffect(effect: () => (() => void) | undefined) {
        if (mounted) return;
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { Play: 'Play', Square: 'Square' },
    '../../cheshiDesktop': { cheshiDesktop: api },
    '../../shared/ui': { NeumorphicButton: 'NeumorphicButton', nonDraggableWindowRegionStyle: { WebkitAppRegion: 'no-drag' } },
    '../../shared/useHelpLanguage': { useHelpLanguage: () => ['ko'] },
  };
  const source = readFileSync(new URL('../frontend/src/features/chrome/KeepAwakeButton.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.KeepAwakeButton;
  assert.ok(typeof component === 'function');
  const render = (): Element | null => {
    stateCursor = 0; refCursor = 0;
    const tree = component({ api }); mounted = true; return tree;
  };
  return { render, calls,
    button() { const tree = render(); assert.ok(tree); return tree; },
    publish(state: KeepAwakeState) { assert.ok(listener); listener(state); },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
    get unsubscribed() { return unsubscribed; },
  };
}

function click(button: Element) { assert.ok(typeof button.props.onClick === 'function'); button.props.onClick(); }
function icon(button: Element) { return (button.props.children as Element).type; }

test('OFF plays, ON stops, and only a confirmed result changes the icon', async () => {
  const app = harness();
  expect(app.button().props.disabled).toBe(true);
  await settle();
  const button = app.button();
  expect(icon(button)).toBe('Play');
  expect(button.props['aria-pressed']).toBe(false);
  expect(button.props.title).toBe('절전 방지 실행');
  click(button);
  expect(icon(app.button())).toBe('Play');
  await settle();
  expect(icon(app.button())).toBe('Square');
  expect(app.button().props['aria-pressed']).toBe(true);
  expect(app.button().props.title).toBe('절전 방지 종료');
  click(app.button());
  await settle();
  expect(icon(app.button())).toBe('Play');
  expect(app.calls).toEqual([true, false]);
  app.unmount();
  expect(app.unsubscribed).toBe(true);
});

test('duplicate clicks are ignored and execution failure is explained without switching ON', async () => {
  const command = createDeferred<KeepAwakeState>();
  let calls = 0;
  const app = harness({ setKeepAwake: () => { calls++; return command.promise; } });
  app.render(); await settle();
  const button = app.button();
  click(button); click(button);
  expect(calls).toBe(1);
  expect(app.button().props.disabled).toBe(true);
  command.reject(new Error('spawn EACCES'));
  await settle();
  expect(app.button().props.disabled).toBe(false);
  expect(icon(app.button())).toBe('Play');
  expect(app.button().props.title).toContain('EACCES');
});

test('newer shared state wins over delayed initial and command responses', async () => {
  const initial = createDeferred<KeepAwakeState>();
  const command = createDeferred<KeepAwakeState>();
  const app = harness({ getKeepAwake: () => initial.promise, setKeepAwake: () => command.promise });
  app.render();
  app.publish({ ...off, enabled: true, revision: 3 });
  initial.resolve(off);
  await settle();
  expect(icon(app.button())).toBe('Square');
  click(app.button());
  app.publish({ ...off, revision: 5, error: 'exited unexpectedly' });
  command.resolve({ ...off, enabled: true, revision: 4 });
  await settle();
  expect(icon(app.button())).toBe('Play');
  expect(app.button().props.title).toContain('exited unexpectedly');
});

test('failed status loading can be retried without starting a process blindly', async () => {
  let reads = 0;
  const app = harness({ getKeepAwake: async () => { if (++reads === 1) throw new Error('unavailable'); return off; } });
  app.render(); await settle();
  expect(app.button().props.title).toContain('상태 다시 확인');
  expect(app.button().props.disabled).toBe(false);
  click(app.button()); await settle();
  expect(app.button().props.title).toBe('절전 방지 실행');
  expect(app.calls).toEqual([]);
});

test('unsupported platforms hide the control and shared busy states disable it', async () => {
  expect(harness({ platform: 'linux' }).render()).toBeNull();
  const app = harness(); app.render(); await settle();
  app.publish({ ...off, busy: true, revision: 1 });
  expect(app.button().props.disabled).toBe(true);
  click(app.button());
  expect(app.calls).toEqual([]);
  app.publish({ ...off, supported: false, revision: 2 });
  expect(app.render()).toBeNull();
});
