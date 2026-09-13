import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraph } from '../src';

describe('TypeScript call receiver safety', () => {
  let directory: string;
  let project: string;
  let previousDataRoot: string | undefined;
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cheshi-call-receivers-'));
    project = join(directory, 'project');
    mkdirSync(project);
    previousDataRoot = process.env.CODEGRAPH_DATA_ROOT;
    process.env.CODEGRAPH_DATA_ROOT = join(directory, 'data');
  });
  afterEach(() => {
    try { graph?.close(); }
    finally {
      graph = undefined;
      if (previousDataRoot === undefined) delete process.env.CODEGRAPH_DATA_ROOT;
      else process.env.CODEGRAPH_DATA_ROOT = previousDataRoot;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function index(source: string, decoys: string) {
    writeFileSync(join(project, 'main.ts'), source);
    writeFileSync(join(project, 'decoys.ts'), decoys);
    graph = await CodeGraph.init(project, { index: true });
    return graph;
  }

  function callees(cg: CodeGraph, caller: string) {
    const source = cg.getNodesByKind('function').find(node => node.name === caller)
      ?? cg.getNodesByKind('method').find(node => node.name === caller);
    expect(source).toBeDefined();
    return cg.getOutgoingEdges(source!.id).filter(edge => edge.kind === 'calls')
      .map(edge => cg.getNode(edge.target)).filter(node => node !== null);
  }

  test('keeps external and chained receivers separate from unrelated methods', async () => {
    const cg = await index(`
import type { Session, WebContents } from 'electron';
export function createShowcaseBrowser(options: { session: Session; ipc: { handle: Function } }, contents: WebContents) {
  options.session.on('will-download', () => {});
  const handle = (channel: string, listener: Function) => options.ipc.handle(channel, listener);
  handle('view', () => {});
  contents.getURL();
  options.window.webContents.on('dom-ready', () => {});
  options.getContents().getURL();
}
`, `
class FakeWorker { on() {} }
class CodexChatUserInputs { handle() {} }
class Contents { getURL() { return ''; } }
`);
    const targets = callees(cg, 'createShowcaseBrowser');
    expect(targets.some(node => node?.filePath.endsWith('decoys.ts'))).toBe(false);
    expect(targets.some(node => node?.name === 'handle' && node.kind === 'function')).toBe(true);
  });

  test('does not guess a receiver type from its variable name', async () => {
    const cg = await index(`export function read(contents: unknown) { return contents.getURL(); }`,
      `class Contents { getURL() { return ''; } }`);
    expect(callees(cg, 'read')).toEqual([]);
  });

  test('does not bind a bare function call to an unrelated class method', async () => {
    const cg = await index(`export function read() { return handle(); }`,
      `class Inputs { handle() {} }`);
    expect(callees(cg, 'read')).toEqual([]);
  });

  test('resolves module singletons without borrowing their types for shadowing parameters', async () => {
    const cg = await index(`
class RealView { getURL() { return ''; } }
const view = new RealView();
export function read() { return view.getURL(); }
export function shadow(view: unknown) { return view.getURL(); }
export function destructured({view}: {view: unknown}) { return view.getURL(); }
export function localShadow() { const view = external(); return view.getURL(); }
export function localDestructured() { const {view} = external(); return view.getURL(); }
`, `class Decoy { getURL() {} }`);
    expect(callees(cg, 'read').some(node => node?.qualifiedName === 'RealView::getURL')).toBe(true);
    expect(callees(cg, 'shadow')).toEqual([]);
    expect(callees(cg, 'destructured')).toEqual([]);
    expect(callees(cg, 'localShadow')).toEqual([]);
    expect(callees(cg, 'localDestructured')).toEqual([]);
  });

  test('preserves inherited, super, and recursive this calls', async () => {
    const cg = await index(`
class Base { getURL() { return ''; } }
class View extends Base {
  refresh() { return this.getURL(); }
  getURL() { return super.getURL(); }
  recursive() { return this.recursive(); }
}
`, `class Decoy { recursive() {} getURL() {} }`);
    expect(callees(cg, 'refresh').some(node => node?.qualifiedName === 'View::getURL')).toBe(true);
    const override = cg.getNodesByKind('method').find(node => node.qualifiedName === 'View::getURL')!;
    expect(cg.getOutgoingEdges(override.id).some(edge => edge.kind === 'calls'
      && cg.getNode(edge.target)?.qualifiedName === 'Base::getURL')).toBe(true);
    const recursive = cg.getNodesByKind('method').find(node => node.qualifiedName === 'View::recursive')!;
    expect(cg.getOutgoingEdges(recursive.id).some(edge => edge.kind === 'calls' && edge.target === recursive.id)).toBe(true);
  });

  test('resolves lexical this through named and nested arrow callbacks', async () => {
    const cg = await index(`
class View {
  finish() {}
  start() {
    const callback = () => this.finish();
    const outer = async () => { const inner = () => this.finish(); return inner(); };
    callback(); outer();
  }
}
`, `class Decoy { finish() {} }`);
    for (const caller of ['callback', 'inner']) {
      expect(callees(cg, caller).map(node => node?.qualifiedName)).toEqual(['View::finish']);
    }
  });

  test('preserves lexical this and super through deferred inherited arrow calls', async () => {
    const cg = await index(`
class Base { finish() {} }
class View extends Base {
  start() {
    const callback = () => this.finish();
    const parent = () => super.finish();
    callback(); parent();
  }
}
`, `class Decoy { finish() {} }`);
    for (const caller of ['callback', 'parent']) {
      expect(callees(cg, caller).map(node => node?.qualifiedName)).toEqual(['Base::finish']);
    }
  });

  test('restores the actual Daemon listen callback connection handler edge', async () => {
    const source = readFileSync(new URL('../src/mcp/daemon.ts', import.meta.url), 'utf8');
    const cg = await index(source, `class Decoy { handleConnection() {} }`);
    expect(callees(cg, 'listen').some(node => node?.qualifiedName === 'Daemon::handleConnection')).toBe(true);
    expect(callees(cg, 'listen').some(node => node?.qualifiedName === 'Decoy::handleConnection')).toBe(false);
  });

  test('does not cross a regular function boundary to borrow the class this', async () => {
    const cg = await index(`
class View {
  finish() {}
  start() {
    function regular() { const nested = () => this.finish(); return nested(); }
    const expression = function () { return this.finish(); };
    regular(); expression();
  }
}
`, `class Decoy { finish() {} }`);
    expect(callees(cg, 'nested')).toEqual([]);
    expect(callees(cg, 'expression')).toEqual([]);
  });

  test('preserves declared receivers, local functions, and class member calls', async () => {
    const cg = await index(`
class RealView {
  getURL() { return ''; }
  refresh() { return this.getURL(); }
  static create() { return new RealView(); }
}
export function read(view: RealView) { return view.getURL(); }
export function constructed() { const view = new RealView(); return view.getURL(); }
export function staticCall() { return RealView.create(); }
export function localCall() { const handle = () => 1; return handle(); }
`, `class Decoy { getURL() {} handle() {} }`);
    for (const name of ['read', 'constructed', 'refresh']) {
      expect(callees(cg, name).some(node => node?.qualifiedName === 'RealView::getURL')).toBe(true);
      expect(callees(cg, name).some(node => node?.filePath.endsWith('decoys.ts'))).toBe(false);
    }
    expect(callees(cg, 'staticCall').some(node => node?.qualifiedName === 'RealView::create')).toBe(true);
    expect(callees(cg, 'localCall').some(node => node?.name === 'handle' && node.kind === 'function')).toBe(true);
  });
});
