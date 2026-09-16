import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { ComponentProps } from 'react';
import type { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';

export interface SessionListElement { type: unknown; props: Record<string, unknown> }
export function sessionListElements(value: unknown): SessionListElement[] {
  if (Array.isArray(value)) return value.flatMap(sessionListElements);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as SessionListElement;
  return [element, ...sessionListElements(element.props.children)];
}

// Exercise actual component props, memo boundaries and handlers without launching the app.
export function createSessionListHarness() {
  let cursor = 0;
  let rowRenders = 0;
  const slots: unknown[] = [];
  let effects: (() => void)[] = [];
  const sameProps = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((key) => Object.is(left[key], right[key]));
  const useMemo = (calculate: () => unknown, dependencies: unknown[]) => {
    const index = cursor++;
    const previous = slots[index] as { dependencies: unknown[]; value: unknown } | undefined;
    if (previous && previous.dependencies.length === dependencies.length
      && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return previous.value;
    const value = calculate();
    slots[index] = { dependencies, value };
    return value;
  };
  const jsx = (type: unknown, props: Record<string, unknown>) =>
    typeof type === 'function' ? type(props) : { type, props };
  const modules: Record<string, unknown> = {
    react: {
      useRef: (current: unknown) => {
        const index = cursor++;
        return slots[index] ??= { current };
      },
      useMemo,
      useCallback: (callback: unknown, dependencies: unknown[]) => useMemo(() => callback, dependencies),
      useLayoutEffect: (effect: () => void) => { effects.push(effect); },
      memo: (component: (props: Record<string, unknown>) => unknown) => {
        const cache = new Map<unknown, { props: Record<string, unknown>; result: unknown }>();
        return (props: Record<string, unknown>) => {
          const previous = cache.get(props.id);
          if (previous && sameProps(previous.props, props)) return previous.result;
          rowRenders += 1;
          const result = component(props);
          cache.set(props.id, { props, result });
          return result;
        };
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': new Proxy({}, { get: (_target, name) => String(name) }),
    '../../shared/ui': {
      LoadingIndicator: ({ label }: { label?: string }) => jsx('loading-indicator', { 'aria-label': label }),
      LoadingState: 'loading-state', NeumorphicButton: 'button',
    },
    './ChatSessionList.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/features/chat/ChatSessionList.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const component = exports.ChatSessionList;
  assert.ok(typeof component === 'function');
  return {
    render(props: ComponentProps<typeof ChatSessionList>) {
      cursor = 0;
      effects = [];
      const result = component(props);
      for (const effect of effects) effect();
      return sessionListElements(result);
    },
    get rowRenders() { return rowRenders; },
  };
}
