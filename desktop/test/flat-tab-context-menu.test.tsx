import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { FlatTabContextMenuTarget } from '../frontend/src/shared/ui/FlatTabContextMenu';

interface Element {
  type: string;
  props: Record<string, unknown>;
}

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

function render(onOpenLocalHistory?: () => void) {
  const calls: string[] = [];
  const jsx = (type: string, props: Record<string, unknown>): Element => ({ type, props });
  const modules: Record<string, unknown> = {
    react: { useRef: () => ({ current: null }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (value: unknown) => value },
    'lucide-react': { Copy: 'Copy', History: 'History', X: 'X' },
    './contextMenuInteractions': { useContextMenuInteractions() {}, focusAdjacentMenuItem() {} },
    './LiquidGlassPanel': { LiquidGlassPanel: 'LiquidGlassPanel' },
    './FlatTabContextMenu.module.css': { default: {} },
  };
  const source = readFileSync(new URL('../frontend/src/shared/ui/FlatTabContextMenu.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports, window: { innerWidth: 800, innerHeight: 600 }, document: { body: {} },
    require(name: string) {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  const component = exports.FlatTabContextMenu;
  if (typeof component !== 'function') throw new Error('Missing menu export');
  const target: FlatTabContextMenuTarget = {
    x: 790, y: 590, title: 'notes.txt', trigger: {} as HTMLButtonElement,
    onOpenLocalHistory: onOpenLocalHistory ? () => { calls.push('history'); onOpenLocalHistory(); } : undefined,
    onCopyFullPath: () => { calls.push('copy'); },
  };
  const tree = component({ target, onClose: () => calls.push('close'), onCloseAll: () => calls.push('close-all') });
  return { tree, calls, items: elements(tree).filter(item => item.props.role === 'menuitem') };
}

function click(item: Element | undefined) {
  const callback = item?.props.onClick;
  if (typeof callback !== 'function') throw new Error('Missing menu action');
  callback();
}

test('file history dismisses the tab menu before opening the requested history', () => {
  let opened = 0;
  const menu = render(() => { opened++; });
  expect(menu.items).toHaveLength(3);
  expect(elements(menu.items[0]).some(item => item.props.children === 'Local history')).toBe(true);
  click(menu.items[0]);
  expect(menu.calls).toEqual(['close', 'history']);
  expect(opened).toBe(1);
  expect(menu.tree.props.style.top + 134).toBeLessThanOrEqual(592);
});

test('tabs without history retain close all and copy actions', () => {
  const menu = render();
  expect(menu.items).toHaveLength(2);
  expect(elements(menu.tree).some(item => item.type === 'History')).toBe(false);
  click(menu.items[0]);
  click(menu.items[1]);
  expect(menu.calls).toEqual(['close', 'close-all', 'close', 'copy']);
});
