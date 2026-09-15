import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeGraph } from '../src';

describe('TypeScript typed property receivers', () => {
  let directory: string;
  let project: string;
  let previousDataRoot: string | undefined;
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cheshi-property-receivers-'));
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

  async function index(files: Record<string, string>) {
    for (const [file, source] of Object.entries(files)) {
      const target = join(project, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    graph = await CodeGraph.init(project, { index: true });
    return graph;
  }

  function callees(cg: CodeGraph, name: string) {
    const callers = cg.getNodesByName(name).filter(node => node.kind === 'method' || node.kind === 'function');
    expect(callers).toHaveLength(1);
    return cg.getOutgoingEdges(callers[0]!.id).filter(edge => edge.kind === 'calls')
      .map(edge => cg.getNode(edge.target)).filter(node => node !== null)
      .map(node => `${node.filePath}:${node.qualifiedName}`);
  }

  test('uses aliased, default, and re-exported imports to identify parameter property types', async () => {
    const cg = await index({
      'a/service.ts': 'export class Service { run() {} }',
      'b/service.ts': 'export default class Service { run() {} }',
      'barrel.ts': "export { Service as Renamed } from './a/service';",
      'main.ts': `
import { Renamed as LocalService } from './barrel';
import OtherService from './b/service';
class A {
  constructor(
    private readonly service: LocalService,
    private other: OtherService,
  ) {}
  first() { this.service.run(); }
  second() { this.other.run(); }
}
`,
    });
    expect(callees(cg, 'first')).toEqual(['a/service.ts:Service::run']);
    expect(callees(cg, 'second')).toEqual(['b/service.ts:Service::run']);
  });

  test('reads a declared field from its own class, independently of local names and sibling classes', async () => {
    const cg = await index({
      'main.ts': `
class First { run() {} }
class Second { run() {} }
class A { private service!: First; first(service: Second) { this.service.run(); } }
class B { private service: Second; second() { this.service.run(); } }
`,
    });
    expect(callees(cg, 'first')).toEqual(['main.ts:First::run']);
    expect(callees(cg, 'second')).toEqual(['main.ts:Second::run']);
  });

  test('does not borrow same-named project classes for external or unbound property types', async () => {
    const cg = await index({
      'decoy.ts': 'export class Service { run() {} }',
      'main.ts': `
import { Service as External } from 'external-package';
class A {
  constructor(private service: External) {}
  external() { this.service.run(); }
}
class B { private service: Service; unbound() { this.service.run(); } }
class C {
  constructor(service: Service) {}
  parameterOnly() { this.service.run(); }
}
class D { private service: External | Service; union() { this.service.run(); } }
class E { private service: External<string> | Service<number>; genericUnion() { this.service.run(); } }
`,
    });
    for (const name of ['external', 'unbound', 'parameterOnly', 'union', 'genericUnion']) expect(callees(cg, name)).toEqual([]);
  });

  test('resolves a local class shadowing an import in the property declaration scope', async () => {
    const cg = await index({
      'service.ts': 'export class Service { run() {} }',
      'main.ts': `
import { Service } from './service';
export function setup() {
  class Service { run() {} }
  class A {
    constructor(private service: Service) {}
    local() { this.service.run(); }
  }
}
class B {
  constructor(private service: Service) {}
  imported() { class Service { run() {} } this.service.run(); }
}
class Generic<Service> {
  constructor(private service: Service) {}
  typeParameter() { this.service.run(); }
}
`,
    });
    expect(callees(cg, 'local')).toEqual(['main.ts:setup::Service::run']);
    expect(callees(cg, 'imported')).toEqual(['service.ts:Service::run']);
    expect(callees(cg, 'typeParameter')).toEqual([]);
  });

  test('retains lexical arrows while rejecting functions and static this receivers', async () => {
    const cg = await index({
      'main.ts': `
class Service { run() {} }
class A {
  constructor(private service: Service) {}
  method() {
    const arrow = () => this.service.run();
    function ordinary() { this.service.run(); }
    const object = { nested() { this.service.run(); } };
  }
  static staticCall() { this.service.run(); }
  static staticParent() { const staticArrow = () => this.service.run(); }
}
`,
    });
    expect(callees(cg, 'arrow')).toEqual(['main.ts:Service::run']);
    for (const name of ['ordinary', 'method', 'staticCall', 'staticArrow']) expect(callees(cg, name)).toEqual([]);
  });

  test('does not interpret constructor default strings or comments as parameter properties', async () => {
    const cg = await index({
      'main.ts': `
class Service { run() {} }
class A {
  constructor(value = ', private service: Service', /* private other: Service */ harmless = 1) {}
  stringDecoy() { this.service.run(); }
  commentDecoy() { this.other.run(); }
}
`,
    });
    expect(callees(cg, 'stringDecoy')).toEqual([]);
    expect(callees(cg, 'commentDecoy')).toEqual([]);
  });

  test('distinguishes reserved-word object methods from actual control-flow blocks', async () => {
    const cg = await index({
      'main.ts': `
class Service { run() {} }
class Other { run() {} }
class A {
  constructor(private service: Service) {}
  objectCatch() { const obj = { service: new Other(), catch() { this.service.run(); } }; }
  objectIf() { const obj = { service: new Other(), if() { this.service.run(); } }; }
  objectWhile() { return { service: new Other(), while() { this.service.run(); } }; }
  controlIf() { if (true) { this.service.run(); } }
  controlFor() { for (let index = 0; index < 1; index++) { this.service.run(); } }
  controlWhile() { while (true) { this.service.run(); break; } }
  controlCatch() { try { throw 1; } catch (error) { this.service.run(); } }
}
`,
    });
    for (const name of ['objectCatch', 'objectIf', 'objectWhile']) {
      expect(callees(cg, name)).not.toContain('main.ts:Service::run');
    }
    for (const name of ['controlIf', 'controlFor', 'controlWhile', 'controlCatch']) {
      expect(callees(cg, name)).toContain('main.ts:Service::run');
    }
  });
});
