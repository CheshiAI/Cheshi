import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import type { GitBranchSummary } from '../frontend/src/cheshiDesktop.ts';

interface TestElement {
  type: unknown;
  props: Record<string, unknown>;
}

// Exercise the component's event callbacks without launching Electron or rendering a UI.
function renderComponent(filename: string, exportName: string, props: Record<string, unknown>): unknown {
  const source = readFileSync(new URL(`../frontend/src/features/git/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const exports: Record<string, unknown> = {};
  const jsx = (type: unknown, attributes: Record<string, unknown>): TestElement => ({ type, props: attributes });
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useMemo: (factory: () => unknown) => factory(),
      useRef: (current: unknown) => ({ current }),
    },
    'react-dom': { createPortal: (element: unknown) => element },
    'lucide-react': {
      ArrowDown: 'arrow-down', ArrowUp: 'arrow-up', ChevronRight: 'chevron-right',
      FolderGit2: 'folder-git', GitBranch: 'git-branch', GitBranchPlus: 'git-branch-plus',
      RefreshCw: 'refresh', X: 'close',
    },
    '../../shared/ui': {
      NeumorphicButton: 'control-button', NeumorphicInput: 'control-input',
      LiquidGlassPanel: 'panel', focusAdjacentMenuItem() {}, useContextMenuInteractions() {},
    },
    './GitBranchContextMenu': { GitBranchContextMenu: 'context-menu' },
    './GitWorkspace.module.css': { default: {} },
    './GitBranchContextMenu.module.css': { default: {} },
  };
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected component dependency: ${name}`);
      return modules[name];
    },
    window: { innerWidth: 1000, innerHeight: 800 },
    document: { body: {} },
  });
  const component = exports[exportName];
  assert.ok(typeof component === 'function');
  return component(props);
}

function isElement(value: unknown): value is TestElement {
  return typeof value === 'object' && value !== null && 'type' in value
    && 'props' in value && typeof value.props === 'object' && value.props !== null;
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}

function invoke(element: TestElement, name: string): void {
  const callback = element.props[name];
  assert.ok(typeof callback === 'function', `Missing ${name} callback`);
  callback();
}

function branch(name: string, current = false, remote = false): GitBranchSummary {
  return {
    name, current, remote, fullName: `refs/${remote ? 'remotes' : 'heads'}/${name}`,
    hash: 'abc1234', upstream: null, upstreamRemote: null, ahead: 0, behind: 0,
  };
}

test('single and double clicks browse local and remote branches without checkout', () => {
  const current = branch('feature/history', true);
  const main = branch('main');
  const remote = branch('origin/main', false, true);
  const selections: string[] = [];
  const checkouts: GitBranchSummary[] = [];
  const tree = renderComponent('GitBranchTree.tsx', 'GitBranchTree', {
    branches: [current, main, remote], disabled: false, selectedReference: main.fullName,
    onSelect: (reference: string) => selections.push(reference),
    onCheckout: (target: GitBranchSummary) => checkouts.push(target),
    onCreate: async () => false, onUpdate() {},
  });
  const rows = elements(tree).filter((element) => element.type === 'button');
  for (const target of [main, remote]) {
    const row = rows.find((element) => element.props['aria-label'] === target.name);
    assert.ok(row);
    invoke(row, 'onClick');
    invoke(row, 'onClick');
    if (typeof row.props.onDoubleClick === 'function') invoke(row, 'onDoubleClick');
  }
  assert.deepEqual(selections, [main.fullName, main.fullName, remote.fullName, remote.fullName]);
  assert.deepEqual(checkouts, []);
  const currentRow = rows.find((element) => element.props['aria-current'] === 'true');
  assert.ok(currentRow);
  assert.equal(currentRow.props['aria-label'], 'feature/history, current branch');
  assert.equal(currentRow.props['aria-pressed'], false);
  assert.equal(rows.find((element) => element.props['aria-label'] === 'main')?.props['aria-pressed'], true);
});

test('the explicit Checkout menu action still requests checkout of its target branch', () => {
  const main = branch('main');
  const checkouts: GitBranchSummary[] = [];
  let closed = 0;
  const menu = renderComponent('GitBranchContextMenu.tsx', 'GitBranchContextMenu', {
    branch: main, disabled: false, x: 100, y: 100,
    onCheckout: (target: GitBranchSummary) => checkouts.push(target),
    onClose: () => { closed += 1; }, onCreateFrom() {}, onUpdate() {},
  });
  const checkout = elements(menu).find((element) => element.type === 'button'
    && elements(element.props.children).some((child) => child.props.children === 'Checkout'));
  assert.ok(checkout);
  invoke(checkout, 'onClick');
  assert.deepEqual(checkouts, [main]);
  assert.equal(closed, 1);
});
