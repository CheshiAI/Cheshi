import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';
import type { CheshiWorkspaceEntry } from '../frontend/src/cheshiDesktop';

interface TestElement {
  type: unknown;
  props: Record<string, unknown>;
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('props' in value)) return [];
  const element = value as TestElement;
  const children = element.type === 'Tooltip' && typeof element.props.children === 'function'
    ? element.props.children({})
    : element.props.children;
  return [element, ...elements(children)];
}

test('Explorer decorates only changed files, including selected files, and retains file activation', () => {
  const jsx = (type: unknown, props: Record<string, unknown>): TestElement => ({ type, props });
  const changedPaths = new Set(['src/modified.ts', 'src/added.ts', 'src/renamed.ts', 'submodule']);
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { Fragment: 'Fragment' },
    'lucide-react': {
      ChevronRight: 'ChevronRight', FileText: 'FileText', Folder: 'Folder',
      FolderInput: 'FolderInput', FolderOpen: 'FolderOpen', RotateCw: 'RotateCw',
    },
    '../../shared/useHorizontalOverflow': {},
    '../../shared/workspaceFileTransfer': {},
    '../../shared/ui': { Tooltip: 'Tooltip' },
    '../../cheshiDesktop': { cheshiDesktop: { workspaceRoot: '/workspace' } },
    './useWorkspaceGitChangedPaths': { useWorkspaceGitChangedPaths: () => changedPaths },
    './workspaceEntryEditInteraction': {},
  };
  const source = readFileSync(new URL('../frontend/src/features/navigation/WorkspaceFileTreeRows.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, { exports, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const render = exports.WorkspaceFileTreeRows;
  assert.ok(typeof render === 'function');
  const paths = ['src/modified.ts', 'src/added.ts', 'src/renamed.ts', 'src/clean.ts', 'submodule'];
  const activated: string[] = [];
  const controller = {
    expandedDirectories: new Set(),
    visibleEntries: paths.map(path => ({ depth: 1, entry: {
      path, name: path.split('/').at(-1), kind: path === 'submodule' ? 'directory' : 'file',
    } })),
    activateEntry: (entry: CheshiWorkspaceEntry) => activated.push(entry.path),
  };
  const rows = elements(render({ controller, selectedPath: paths[0] }))
    .filter(element => element.type === 'button');
  expect(rows).toHaveLength(paths.length);
  expect(rows.map(row => row.props['data-git-changed'])).toEqual([
    'true', 'true', 'true', undefined, undefined,
  ]);
  expect(rows[0]?.props['aria-selected']).toBe(true);
  const activate = rows[0]?.props.onClick;
  assert.ok(typeof activate === 'function');
  activate();
  expect(activated).toEqual(['src/modified.ts']);

  changedPaths.clear();
  const cleanRows = elements(render({ controller, selectedPath: paths[0] }))
    .filter(element => element.type === 'button');
  expect(cleanRows.every(row => row.props['data-git-changed'] === undefined)).toBe(true);
});
