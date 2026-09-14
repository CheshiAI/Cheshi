import { afterEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';

// Deliberately do not load grammars on this thread: indexAll parses in workers,
// and resolving a store call must work without a main-thread parser cache.
describe('store action receiver ownership', () => {
  let graph: CodeGraph | undefined;
  let directory: string;
  afterEach(() => {
    if (directory) cleanupGraphTest(graph, directory);
    graph = undefined;
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    directory = createTempDir();
    for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
    graph = CodeGraph.initSync(directory);
    await graph.indexAll();
    return graph;
  }

  function callers(cg: CodeGraph, file: string, name: string, occurrence = 0): string[] {
    const targets = cg.getNodesByKind('function').filter(node => node.filePath === file && node.name === name)
      .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
    expect(targets[occurrence]).toBeDefined();
    return cg.getCallers(targets[occurrence]!.id).map(caller => caller.node.name).sort();
  }

  it('pins imported aliases and sibling getters to their own store across files', async () => {
    const cg = await index({
      'one.ts': `import { create as make } from 'zustand';
export const first = make((set, read) => ({
  reset: () => set({}),
  refreshFirst: () => read().reset(),
}));`,
      'two.ts': `import { create } from 'zustand';
export const second = create((set, get) => ({
  reset: () => set({}),
  refreshSecond: () => get().reset(),
}));`,
      'caller.ts': `import { first as selected } from './one';
import { second } from './two';
export function clearFirst() { selected.getState().reset(); }
export function clearSecond() { second.getState().reset(); }`,
    });
    expect(callers(cg, 'one.ts', 'reset')).toEqual(['clearFirst', 'refreshFirst']);
    expect(callers(cg, 'two.ts', 'reset')).toEqual(['clearSecond', 'refreshSecond']);
  });

  it('separates same-named actions in stores in the same file, including middleware', async () => {
    const cg = await index({
      'store.ts': `import { create } from 'zustand';
import { persist as save } from 'zustand/middleware';
interface State { reset(): void }
export const first = create<State>()((set, get) => ({
  reset: () => set({}),
  refreshFirst: () => get().reset(),
}));
export const second = create(save((set, get) => ({
  text: "} return { fake: () => {}",
  items: [1, 2, { nested: [] }],
  // { unmatched example in a comment
  reset: () => set({}),
  refreshSecond: () => get().reset(),
}), { name: 'counter' }));
export function clearFirst() { first.getState().reset(); }
export function clearSecond() { second.getState().reset(); }`,
    });
    expect(callers(cg, 'store.ts', 'reset', 0)).toEqual(['clearFirst', 'refreshFirst']);
    expect(callers(cg, 'store.ts', 'reset', 1)).toEqual(['clearSecond', 'refreshSecond']);
  });

  it('rejects shadowed imported receivers and initializer getters', async () => {
    const cg = await index({
      'store.ts': `import { create } from 'zustand';
export const store = create((set, get) => ({
  reset: () => set({}),
  shadowParameter: (get: any) => get().reset(),
  shadowLocal: () => { const get = () => ({ reset() {} }); get().reset(); },
  nestedParameter: () => { const invoke = (get: any) => get().reset(); invoke(null); },
  shadowFunction: () => { function get() { return anything(); } get().reset(); },
  valid: () => get().reset(),
}));`,
      'caller.ts': `import { store } from './store';
export function shadowParameter(store: any) { store.getState().reset(); }
export function shadowLocal() { const store = anything(); store.getState().reset(); }
export function validImport() { store.getState().reset(); }`,
    });
    expect(callers(cg, 'store.ts', 'reset')).toEqual(['valid', 'validImport']);
  });

  it('does not borrow nested methods, missing actions or methods from arbitrary factories', async () => {
    const cg = await index({
      'store.ts': `import { create } from 'zustand';
export const real = create((set, get) => ({
  reset: () => set({}),
  nested: { hidden: () => {} },
  run: () => get().missing(),
}));
export const other = wrap((set, get) => ({
  reset: () => set({}),
  fake: () => get().reset(),
}));
export function invokeFake() { other.getState().reset(); }
export function missing() {}
export function hidden() {}
export function invokeMissing() { real.getState().missing(); }
export function invokeNested() { real.getState().hidden(); }`,
    });
    expect(callers(cg, 'store.ts', 'reset', 0)).toEqual([]);
    expect(callers(cg, 'store.ts', 'reset', 1)).toEqual([]);
    expect(callers(cg, 'store.ts', 'missing')).toEqual([]);
    expect(callers(cg, 'store.ts', 'hidden')).toEqual([]);
  });

  it('leaves conditional initializers, unknown middleware and regex delimiters unresolved', async () => {
    const cg = await index({
      'store.ts': `import { create } from 'zustand';
import { combine } from 'zustand/middleware';
export const conditional = create((set, get) => {
  if (flag) return { reset: () => set({}) };
  return { reset: () => set({}) };
});
export const combined = create(combine((set, get) => ({ reset: () => set({}) })));
export const pattern = create((set, get) => ({
  expression: /[{}]/,
  reset: () => set({}),
}));
export function conditionalCall() { conditional.getState().reset(); }
export function combinedCall() { combined.getState().reset(); }
export function patternCall() { pattern.getState().reset(); }`,
    });
    for (const target of cg.getNodesByKind('function').filter(node => node.name === 'reset')) {
      expect(cg.getCallers(target.id).map(caller => caller.node.name)).toEqual([]);
    }
  });

  it('does not use a factory import shadowed in an exported namespace', async () => {
    const cg = await index({
      'store.ts': `import { create } from 'zustand';
export namespace local {
  const create = otherFactory;
  export const store = create((set, get) => ({
    reset: () => set({}),
    localCall: () => get().reset(),
  }));
}`,
    });
    expect(callers(cg, 'store.ts', 'reset')).toEqual([]);
  });

  it('does not assume an inline action survives a spread or computed property', async () => {
    const cg = await index({
      'store.ts': `import { create } from 'zustand';
export const spread = create((set, get) => ({
  reset: () => set({}),
  ...overrides,
}));
export const computed = create((set, get) => ({
  reset: () => set({}),
  [key]: replacement,
}));
export function spreadCall() { spread.getState().reset(); }
export function computedCall() { computed.getState().reset(); }`,
    });
    expect(callers(cg, 'store.ts', 'reset', 0)).toEqual([]);
    expect(callers(cg, 'store.ts', 'reset', 1)).toEqual([]);
  });
});
