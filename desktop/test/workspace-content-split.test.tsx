import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'bun:test';
import ts from 'typescript';

interface Element { props: Record<string, unknown> }
function harness() {
  let ratio = 0.5;
  const resized = { current: false };
  const source = ts.transpileModule(readFileSync(new URL('../frontend/src/features/shell/WorkspaceContentSplit.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const jsx = (_type: unknown, props: Element['props']): Element => ({ props });
  const modules: Record<string, unknown> = {
    react: { useState: () => [ratio, (next: number) => { ratio = next; }],
      useRef: () => resized, useCallback: (callback: unknown) => callback },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../shared/ui/SplitPaneLayout': { SplitPaneLayout: 'split' },
    '../../shared/ui/workspaceSplitRatioContext': { WorkspaceSplitRatioContext: { Provider: 'context' } },
    './WorkspaceContentSplit.module.css': { default: {} },
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports, require(name: string) {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name];
  } });
  const component = exports.WorkspaceContentSplit;
  assert.ok(typeof component === 'function');
  return {
    render(editorOpen = true) {
      const tree = component({ editorOpen, editor: 'editor', children: 'chat' }) as Element;
      const context = tree.props.value as { ratio: number; restore: (ratio: number) => void };
      const split = tree.props.children as Element;
      return { ...context, resize: split.props.onResizeSplit as (id: string, ratio: number) => void,
        collapsed: split.props.collapsedPane, layout: split.props.layout as { ratio: number } };
    },
  };
}

test('restores a saved ratio and preserves it across editor collapse and reopen', () => {
  const app = harness();
  app.render().restore(0.67);
  expect(app.render().layout.ratio).toBe(0.67);
  expect(app.render(false).collapsed).toBe('first');
  expect(app.render().layout.ratio).toBe(0.67);
  const relaunched = harness();
  relaunched.render().restore(app.render().ratio);
  expect(relaunched.render().layout.ratio).toBe(0.67);
});

test('a late session read cannot undo user resizing or an explicit reset to half width', () => {
  for (const ratio of [0.73, 0.5]) {
    const app = harness();
    app.render().resize('workspace-content', ratio);
    app.render().restore(0.67);
    expect(app.render().layout.ratio).toBe(ratio);
  }
});
