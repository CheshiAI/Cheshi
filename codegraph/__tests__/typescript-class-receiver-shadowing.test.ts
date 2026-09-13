import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../src';

describe('JavaScript class receiver shadowing', () => {
  let directory: string;
  let project: string;
  let previousDataRoot: string | undefined;
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cheshi-class-shadowing-'));
    project = join(directory, 'project');
    mkdirSync(project);
    previousDataRoot = process.env.CODEGRAPH_DATA_ROOT;
    process.env.CODEGRAPH_DATA_ROOT = join(directory, 'data');
  });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    if (previousDataRoot === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
    else process.env.CODEGRAPH_DATA_ROOT = previousDataRoot;
    rmSync(directory, { recursive: true, force: true });
  });

  async function index(source: string, extension = 'ts') {
    writeFileSync(join(project, `main.${extension}`), source);
    graph = await CodeGraph.init(project, { index: true });
    return graph;
  }

  function callees(cg: CodeGraph, name: string) {
    const caller = cg.getNodesByKind('function').find(node => node.name === name)!;
    expect(caller).toBeDefined();
    return cg.getOutgoingEdges(caller.id).filter(edge => edge.kind === 'calls')
      .map(edge => cg.getNode(edge.target)?.qualifiedName);
  }

  test('does not borrow a class name for an unknown parameter or local binding', async () => {
    const cg = await index(`
class View { static create() {} }
export function shadow(View: unknown) { View.create(); }
export function local() { const View = external(); View.create(); }
export function destructured({View}: {View: unknown}) { View.create(); }
export function localDestructured() { const {View} = external(); View.create(); }
export function captured(View: unknown) {
  const callback = () => View.create();
  callback();
}
export function hoisted() { View.create(); var View = external(); }
export function comma() { let other = 1, View = external(); View.create(); }
export function block() { { let View = external(); View.create(); } }
export function sameLine(View: unknown) { View.create(); } export function sameLineDirect() { View.create(); }
`);
    expect(callees(cg, 'sameLineDirect')).toContain('View::create');
    for (const caller of ['shadow', 'local', 'destructured', 'localDestructured', 'callback', 'hoisted', 'block', 'sameLine', 'comma']) {
      expect(callees(cg, caller)).not.toContain('View::create');
    }
  });

  test('retains static calls and proven receiver types, without sibling-scope interference', async () => {
    const cg = await index(`
class View { static create() {} }
class RealView { create() {} }
export function shadow(View: unknown) { View.create(); }
export function direct() { View.create(); }
export function typed(View: RealView) { View.create(); }
export function constructed() { const View = new RealView(); View.create(); }
export function typedOtherArgument(value: View) { View.create(); }
export function siblingBlock() {
  { const View = external(); }
  View.create();
}
export function nestedFunction() {
  function inner(View: unknown) { View.create(); }
  View.create();
}
export function callArgument() { const other = external(1, View); View.create(); }
export function destructuringKey() { const {View: other} = external(); View.create(); }
export function commented() {
  // const View = external();
  const text = 'let View = external();';
  View.create();
}
`);
    for (const caller of ['direct', 'typedOtherArgument', 'commented', 'siblingBlock', 'nestedFunction', 'callArgument', 'destructuringKey']) {
      expect(callees(cg, caller)).toContain('View::create');
    }
    for (const caller of ['typed', 'constructed']) {
      expect(callees(cg, caller)).toContain('RealView::create');
      expect(callees(cg, caller)).not.toContain('View::create');
    }
  });

  test('applies the same guard to JavaScript parameters', async () => {
    const cg = await index(`
class View { static create() {} }
export function shadow(View) { View.create(); }
export function direct() { View.create(); }
`, 'js');
    expect(callees(cg, 'shadow')).not.toContain('View::create');
    expect(callees(cg, 'direct')).toContain('View::create');
  });

  test('limits lexical loop bindings to their loop', async () => {
    const cg = await index(`
class View { static create() {} }
export function afterOf() { for (const View of views) {} View.create(); }
export function afterIn() { for (let View in views) {} View.create(); }
export function afterClassic() { for (let View = external(); condition(); advance()) {} View.create(); }
export function insideOf() { for (const View of views) { View.create(); } }
export function insideIn() { for (let View in views) { View.create(); } }
export function insideClassic() { for (let View = external(); condition(); advance()) { View.create(); } }
export function unbracedAfter() { for (const View of views) consume(View); View.create(); }
export function unbracedInside() { for (const View of views) View.create(); }
`);
    for (const caller of ['afterOf', 'afterIn', 'afterClassic', 'unbracedAfter']) {
      expect(callees(cg, caller)).toContain('View::create');
    }
    for (const caller of ['insideOf', 'insideIn', 'insideClassic', 'unbracedInside']) {
      expect(callees(cg, caller)).not.toContain('View::create');
    }
  });

  test('keeps var loop bindings in their enclosing function scope', async () => {
    const cg = await index(`
class View { static create() {} }
export function varOf() { for (var View of views) {} View.create(); }
export function varIn() { for (var View in views) {} View.create(); }
export function varClassic() { for (var View = external(); condition(); advance()) {} View.create(); }
export function beforeVarLoop() { View.create(); for (var View of views) {} }
export function sibling() { View.create(); }
`);
    for (const caller of ['varOf', 'varIn', 'varClassic', 'beforeVarLoop']) {
      expect(callees(cg, caller)).not.toContain('View::create');
    }
    expect(callees(cg, 'sibling')).toContain('View::create');
  });

  test('ends unbraced loop scope at an automatically inserted semicolon', async () => {
    const cg = await index(`
class View { static create() {} }
export function afterAutomaticSemicolon() {
  for (const View of views) consume(View)
  View.create()
}
export function insideAutomaticSemicolon() {
  for (const View of views) View.create()
}
`);
    expect(callees(cg, 'afterAutomaticSemicolon')).toContain('View::create');
    expect(callees(cg, 'insideAutomaticSemicolon')).not.toContain('View::create');
  });

  test('covers both branches of an unbraced conditional loop body', async () => {
    const cg = await index(`
class View { static create() {} }
export function afterConditionalBody() {
  for (const View of views) if (condition()) consume(View); else fallback(View);
  View.create();
}
export function insideConditionalThen() {
  for (const View of views) if (condition()) View.create(); else fallback(View);
}
export function insideConditionalElse() {
  for (const View of views) if (condition()) consume(View); else View.create();
}
`);
    expect(callees(cg, 'afterConditionalBody')).toContain('View::create');
    for (const caller of ['insideConditionalThen', 'insideConditionalElse']) {
      expect(callees(cg, caller)).not.toContain('View::create');
    }
  });

  test('distinguishes destructuring bindings from names in their type annotations', async () => {
    const cg = await index(`
class View { static create() {} }
export function objectType() { const { value }: { value: View } = options; View.create(); }
export function arrayType() { const [value]: [View] = options; View.create(); }
export function nestedType() { const { nested: { value } }: { nested: { value: View } } = options; View.create(); }
export function objectAlias() { const { value: View } = options; View.create(); }
export function typedObjectAlias() { const { value: View }: { value: unknown } = options; View.create(); }
export function arrayBinding() { const [View]: unknown[] = options; View.create(); }
export function nestedBinding() { const { nested: { value: View } } = options; View.create(); }
`);
    for (const caller of ['objectType', 'arrayType', 'nestedType']) {
      expect(callees(cg, caller)).toContain('View::create');
    }
    for (const caller of ['objectAlias', 'typedObjectAlias', 'arrayBinding', 'nestedBinding']) {
      expect(callees(cg, caller)).not.toContain('View::create');
    }
  });
});
