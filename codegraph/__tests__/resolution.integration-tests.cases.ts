import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';

export function registerIntegrationTestsTests(scope: {
  tempDir: string;
  cg: CodeGraph;
}): void {


  describe('Integration Tests', () => {
    it('should create resolver from CodeGraph instance', async () => {
      // Create a simple TypeScript project
      fs.writeFileSync(
        path.join(scope.tempDir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { react: '^18.0.0' } })
      );

      const srcDir = path.join(scope.tempDir, 'src');
      fs.mkdirSync(srcDir);

      // Create utility file
      fs.writeFileSync(
        path.join(srcDir, 'utils.ts'),
        `export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(str: string): Date {
  return new Date(str);
}`
      );

      // Create main file that uses utils
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { formatDate, parseDate } from './utils';

function processDate(input: string): string {
  const date = parseDate(input);
  return formatDate(date);
}`
      );

      // Initialize and index
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      // Check that resolver detected React framework
      const frameworks = scope.cg.getDetectedFrameworks();
      expect(frameworks).toContain('react');

      // Get stats to verify indexing worked
      const stats = scope.cg.getStats();
      expect(stats.fileCount).toBe(2);
      expect(stats.nodeCount).toBeGreaterThan(0);
    });

    it('should resolve references after indexing', async () => {
      // Create a project with references
      const srcDir = path.join(scope.tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'helper.ts'),
        `export function helperFunction(): void {
  console.log('helper');
}`
      );

      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { helperFunction } from './helper';

function main(): void {
  helperFunction();
}`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      // Run reference resolution
      const result = scope.cg.resolveReferences();

      // Should have attempted resolution
      expect(result.stats.total).toBeGreaterThanOrEqual(0);
    });

    it('promotes calls→instantiates when target resolves to a class (Python)', async () => {
      // Python has no `new` keyword — `Foo()` is the standard
      // instantiation syntax. Extraction can't tell that apart from
      // a function call without symbol info, so it emits a `calls`
      // ref. Resolution promotes it to `instantiates` once the
      // target is known to be a class.
      const srcDir = path.join(scope.tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'app.py'),
        `class UserService:
    def __init__(self):
        self.db = None

def bootstrap():
    return UserService()
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const bootstrap = scope.cg
        .getNodesByKind('function')
        .find((n) => n.name === 'bootstrap');
      expect(bootstrap).toBeDefined();

      const outgoing = scope.cg.getOutgoingEdges(bootstrap!.id);
      const instantiates = outgoing.find((e) => e.kind === 'instantiates');
      expect(instantiates).toBeDefined();
      // Same edge must NOT also appear as a `calls` edge — promotion
      // replaces the kind, doesn't duplicate.
      const callsToUserService = outgoing.filter(
        (e) => e.kind === 'calls' && e.target === instantiates!.target
      );
      expect(callsToUserService).toHaveLength(0);
    });

    it('records instantiates for C++ stack/brace construction, targeting the class (#1035)', async () => {
      // `Calculator calc(0)` (direct-init) and `Widget w{1, 2}` (brace-init)
      // carry the constructor args directly on the declarator — there's no
      // call/new node — so they recorded no `instantiates` edge, while heap
      // `new Calculator(0)` did. Both stack forms now do.
      fs.writeFileSync(
        path.join(scope.tempDir, 'm.cpp'),
        `class Calculator { public: Calculator(int seed) {} int add(int a, int b){ return a+b; } };
class Widget { public: Widget(int a, int b) {} };

int runStack(int a, int b) { Calculator calc(0); return calc.add(a, b); }
int runBrace() { Widget w{1, 2}; return 0; }
int runHeap(int a, int b) { Calculator* c = new Calculator(0); return c->add(a, b); }
void noise() { int x(5); int y{6}; Calculator deferred; }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const fn = (name: string) => scope.cg.getNodesByKind('function').find((n) => n.name === name)!;
      const instTargets = (name: string) =>
        scope.cg
          .getOutgoingEdges(fn(name).id)
          .filter((e) => e.kind === 'instantiates')
          .map((e) => scope.cg.getNode(e.target)!);

      // Direct-init (the issue) and brace-init both instantiate, targeting the
      // CLASS node — not the same-named constructor method.
      const stack = instTargets('runStack');
      expect(stack.map((n) => `${n.kind}:${n.name}`)).toContain('class:Calculator');
      expect(instTargets('runBrace').map((n) => `${n.kind}:${n.name}`)).toContain('class:Widget');
      // Heap still works (regression guard).
      expect(instTargets('runHeap').map((n) => `${n.kind}:${n.name}`)).toContain('class:Calculator');
      // Primitives (`int x(0)`/`int y{6}`) and bare default construction
      // (`Calculator deferred;`) must NOT mint an instantiates edge.
      expect(instTargets('noise')).toHaveLength(0);
    });

    it('resolves a cross-file static method call to the method, not the class (#825)', async () => {
      // `Foo.bar()` where `Foo` is an imported class must link to the static
      // method `Foo::bar`, NOT to the class `Foo`. Previously the import
      // resolver dropped the `.bar` member and resolved to `Foo`, which the
      // calls→instantiates promotion then turned into `run instantiates Foo`,
      // leaving the static method with zero callers and a hollow impact radius.
      fs.writeFileSync(
        path.join(scope.tempDir, 'helpers.ts'),
        `export class Foo {\n  static bar(x: number) { return x + 1; }\n}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'caller.ts'),
        `import { Foo } from './helpers';\nexport function run() { return Foo.bar(41); }\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const bar = scope.cg.getNodesByKind('method').find((n) => n.name === 'bar');
      const foo = scope.cg.getNodesByKind('class').find((n) => n.name === 'Foo');
      const run = scope.cg.getNodesByKind('function').find((n) => n.name === 'run');
      expect(bar).toBeDefined();
      expect(foo).toBeDefined();
      expect(run).toBeDefined();

      // `run` is reported as a caller of the static method `Foo.bar`.
      const barCallers = scope.cg.getCallers(bar!.id).map((c) => c.node.name);
      expect(barCallers).toContain('run');

      // And the call is NOT mis-promoted to `run instantiates Foo`.
      const outgoing = scope.cg.getOutgoingEdges(run!.id);
      expect(
        outgoing.filter((e) => e.kind === 'instantiates' && e.target === foo!.id)
      ).toHaveLength(0);
      // The real edge is a `calls` edge to the method.
      expect(
        outgoing.some((e) => e.kind === 'calls' && e.target === bar!.id)
      ).toBe(true);
    });

    it('resolves Go cross-package qualified calls via go.mod module path (#388)', async () => {
      // Pre-#388, every `pkga.FuncX(...)` call in a Go monorepo was flagged
      // external (isExternalImport returned true for any non-`/internal/`
      // import without `.`-prefix) and resolution fell through to name-match
      // with path proximity — recall on cross-package callers was ~<1%.
      fs.writeFileSync(
        path.join(scope.tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );

      const pkgaDir = path.join(scope.tempDir, 'pkga');
      const pkgbDir = path.join(scope.tempDir, 'pkgb');
      const pkgcDir = path.join(scope.tempDir, 'pkgc');
      fs.mkdirSync(pkgaDir);
      fs.mkdirSync(pkgbDir);
      fs.mkdirSync(pkgcDir);

      // Same-name exported function in two packages — only the imported one
      // should resolve. Exercises disambiguation, not just connectivity.
      fs.writeFileSync(
        path.join(pkgaDir, 'conv.go'),
        'package pkga\nfunc Convert(x int) int { return x * 2 }\n'
      );
      fs.writeFileSync(
        path.join(pkgbDir, 'conv.go'),
        'package pkgb\nfunc Convert(x int) int { return x + 1 }\n'
      );
      fs.writeFileSync(
        path.join(pkgcDir, 'use.go'),
        `package pkgc

import "github.com/example/myproject/pkga"

func UsePkga() {
  pkga.Convert(5)
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const usePkga = scope.cg.getNodesByKind('function').filter((n) => n.name === 'UsePkga')[0];
      expect(usePkga).toBeDefined();

      const outgoing = scope.cg.getOutgoingEdges(usePkga!.id);
      const callEdges = outgoing.filter((e) => e.kind === 'calls');
      expect(callEdges).toHaveLength(1);

      const target = scope.cg.getNode(callEdges[0]!.target);
      expect(target?.name).toBe('Convert');
      // Critical: the resolver must pick the imported pkga's Convert,
      // not pkgb's. With the broken (pre-fix) resolver this lands on
      // whichever Convert happens to be cheaper under path proximity.
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkga/conv.go');
    });

    it('resolves Go aliased imports across packages (#388)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );
      fs.mkdirSync(path.join(scope.tempDir, 'pkgb'));
      fs.mkdirSync(path.join(scope.tempDir, 'pkgd'));

      fs.writeFileSync(
        path.join(scope.tempDir, 'pkgb', 'lib.go'),
        'package pkgb\nfunc Compute(x int) int { return x }\n'
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'pkgd', 'use.go'),
        `package pkgd

import (
  "fmt"
  alias "github.com/example/myproject/pkgb"
)

func UseAliased() {
  fmt.Println("hi")
  alias.Compute(3)
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const useAliased = scope.cg.getNodesByKind('function').filter((n) => n.name === 'UseAliased')[0];
      expect(useAliased).toBeDefined();
      const calls = scope.cg.getOutgoingEdges(useAliased!.id).filter((e) => e.kind === 'calls');
      // fmt.Println is stdlib — must stay external. alias.Compute must resolve.
      expect(calls).toHaveLength(1);
      const target = scope.cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('Compute');
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkgb/lib.go');
    });

    it('resolves Python module-attribute calls after `from pkg import module` (#578)', async () => {
      // Pre-#578, a `module.func()` call where `module` was bound via
      // `from pkg import module` dropped its `calls` edge. The file→file import
      // edge resolved (resolveModuleImportToFile falls back to a dotted-module
      // file lookup for absolute package paths), but resolvePythonModuleMember
      // had no such fallback — resolveImportPath returns null for an absolute
      // package path like `pkg.module`, so the member never resolved and
      // callers/callees/impact on the target came back empty. Same root-cause
      // class as the Go cross-package qualified call (#388).
      fs.mkdirSync(path.join(scope.tempDir, 'pkg'));
      fs.writeFileSync(path.join(scope.tempDir, 'pkg', '__init__.py'), '');
      fs.writeFileSync(
        path.join(scope.tempDir, 'pkg', 'module.py'),
        'def func():\n    return 1\n'
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.py'),
        `from pkg import module
import os


def caller():
    return module.func()


def external_caller():
    return os.getcwd()
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const caller = scope.cg.getNodesByKind('function').filter((n) => n.name === 'caller')[0];
      expect(caller).toBeDefined();
      const calls = scope.cg.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls');
      // module.func() must resolve to the real function in the submodule file.
      expect(calls).toHaveLength(1);
      const target = scope.cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('func');
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkg/module.py');

      // The flip side of the fix: an attribute call through a *stdlib* module
      // (`os.getcwd()`) must still create no edge — the fallback only matches
      // real in-repo module files.
      const externalCaller = scope.cg.getNodesByKind('function').filter((n) => n.name === 'external_caller')[0];
      expect(externalCaller).toBeDefined();
      const externalCalls = scope.cg.getOutgoingEdges(externalCaller!.id).filter((e) => e.kind === 'calls');
      expect(externalCalls).toHaveLength(0);
    });

    it('attaches Go methods to their receiver type across files (#583, cross-file half)', async () => {
      // In Go a type's methods are commonly declared in a different file from the
      // `type` declaration (`type Box` in box.go, `func (b *Box) Get()` in
      // box_methods.go). Extraction only attaches the struct→method `contains`
      // edge when the type is in the SAME file (the owner lookup is file-scoped),
      // so a cross-file method was orphaned from its struct — breaking member
      // outlines and any callers/callees/impact traversal through `contains`. A
      // resolution-phase pass now links them within the package (= directory).
      fs.writeFileSync(
        path.join(scope.tempDir, 'box.go'),
        'package main\n\ntype Box struct{ v int }\n'
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'box_methods.go'),
        'package main\n\nfunc (b *Box) Get() int { return b.v }\nfunc (b *Box) Set(x int) { b.v = x }\n'
      );
      // Generic receiver declared cross-file too — exercises #583 half A
      // (generic `*Stack[T]` receiver parsing) and half B (cross-file) together.
      fs.writeFileSync(
        path.join(scope.tempDir, 'stack.go'),
        'package main\n\ntype Stack[T any] struct {\n\titems []T\n}\n'
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'stack_push.go'),
        'package main\n\nfunc (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }\n'
      );
      // A same-named type in another package must NOT capture this package's
      // methods — the link is scoped to the receiver type's own directory.
      fs.mkdirSync(path.join(scope.tempDir, 'other'));
      fs.writeFileSync(
        path.join(scope.tempDir, 'other', 'box.go'),
        'package other\n\ntype Box struct{ w int }\n'
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const methodsOf = (typeName: string, file: string): string[] => {
        const node = scope.cg
          .getNodesByKind('struct')
          .find((n) => n.name === typeName && n.filePath.replace(/\\/g, '/') === file);
        expect(node, `${typeName} @ ${file}`).toBeDefined();
        return scope.cg
          .getOutgoingEdges(node!.id)
          .filter((e) => e.kind === 'contains')
          .map((e) => scope.cg.getNode(e.target))
          .filter((n) => !!n && n.kind === 'method')
          .map((n) => n!.name)
          .sort();
      };

      // Cross-file (non-generic) methods now attach to their struct.
      expect(methodsOf('Box', 'box.go')).toEqual(['Get', 'Set']);
      // Generic + cross-file.
      expect(methodsOf('Stack', 'stack.go')).toEqual(['Push']);
      // Cross-package isolation: other/Box defines no methods of its own.
      expect(methodsOf('Box', 'other/box.go')).toEqual([]);
    });

    it('TS type_alias object-shape members resolve method calls (#359)', async () => {
      // Pre-#359, `recorder.stop()` (recorder: RecorderHandle) attached
      // to `StdioMcpClient.stop` in a sibling directory via path-proximity
      // because the type_alias had no `stop` node — only the unrelated
      // class did. Now type_alias produces member nodes (property/method),
      // so the camelCase receiver↔type word overlap pulls the call to
      // `RecorderHandle::stop` instead of the look-alike class.
      fs.mkdirSync(path.join(scope.tempDir, 'voice'));
      fs.mkdirSync(path.join(scope.tempDir, 'codegraph'));

      fs.writeFileSync(
        path.join(scope.tempDir, 'voice', 'recorder.ts'),
        `export type RecorderHandle = {
  wavPath: string;
  stop: () => Promise<{ ok: true }>;
};
`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'voice', 'controller.ts'),
        `import type { RecorderHandle } from "./recorder";
export async function finaliseRecording(recorder: RecorderHandle) {
  return await recorder.stop();
}
`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'codegraph', 'stdio-client.ts'),
        `export class StdioMcpClient {
  private stopped = false;
  async stop(): Promise<void> { this.stopped = true; }
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const handleStop = scope.cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'RecorderHandle::stop');
      expect(handleStop).toBeDefined();

      const clientStop = scope.cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'StdioMcpClient::stop');
      expect(clientStop).toBeDefined();

      const handleCallers = scope.cg.getIncomingEdges(handleStop!.id).filter((e) => e.kind === 'calls');
      const clientCallers = scope.cg.getIncomingEdges(clientStop!.id).filter((e) => e.kind === 'calls');
      expect(handleCallers.length).toBeGreaterThanOrEqual(1);
      // The class method must have NO callers — voice/'s call must NOT
      // mis-attribute. A non-empty list would mean the false-positive
      // path is still firing.
      expect(clientCallers).toHaveLength(0);

      // Function-typed property surfaces as a `method` node, not `property`,
      // because `stop()` semantics at the call site are method semantics.
      expect(handleStop!.kind).toBe('method');
    });

    it('Java import disambiguates same-name classes across modules (#314)', async () => {
      // Pre-#314 the import resolver had no Java branch at all, so a
      // multi-module Maven repo where `dao/converter/FooConverter` and
      // `service/converter/FooConverter` both export a `convert` method
      // resolved by file-path proximity — picking whichever class was
      // closer to the caller, which is wrong any time the caller lives
      // in an equidistant cross-cutting module.
      const daoDir = path.join(scope.tempDir, 'dao/src/main/java/com/example/dao/converter');
      const serviceDir = path.join(scope.tempDir, 'service/src/main/java/com/example/service/converter');
      const webDir = path.join(scope.tempDir, 'web/src/main/java/com/example/web');
      fs.mkdirSync(daoDir, { recursive: true });
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.mkdirSync(webDir, { recursive: true });

      fs.writeFileSync(
        path.join(daoDir, 'FooConverter.java'),
        `package com.example.dao.converter;
public class FooConverter { public String convert(String x) { return "dao:" + x; } }
`
      );
      fs.writeFileSync(
        path.join(serviceDir, 'FooConverter.java'),
        `package com.example.service.converter;
public class FooConverter { public String convert(String x) { return "svc:" + x; } }
`
      );
      // The caller imports the SERVICE version — even though dao is
      // alphabetically/lexically first in the candidate list, the
      // import must trump that order.
      fs.writeFileSync(
        path.join(webDir, 'Handler.java'),
        `package com.example.web;

import com.example.service.converter.FooConverter;

public class Handler {
  private FooConverter fooConverter;
  public String use() { return fooConverter.convert("input"); }
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const use = scope.cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'com.example.web::Handler::use');
      expect(use).toBeDefined();
      const calls = scope.cg.getOutgoingEdges(use!.id).filter((e) => e.kind === 'calls');
      expect(calls.length).toBeGreaterThanOrEqual(1);

      const target = scope.cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('convert');
      expect(target?.filePath.replace(/\\/g, '/')).toBe(
        'service/src/main/java/com/example/service/converter/FooConverter.java'
      );
    });

    it('C# extracts references from method/property/field types (#381)', async () => {
      // Pre-#381, every C# project produced ZERO `references` edges:
      // csharp.ts was missing returnField, and the type-leaf walker
      // only recognized TS/Java's `type_identifier` nodes — C# uses
      // `identifier`/`predefined_type`/`qualified_name`/`generic_name`.
      const srcDir = path.join(scope.tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'Dtos.cs'),
        `namespace MyApp;
public class SessionInfoDto { public string Id { get; set; } = ""; }
public class UserDto { public string Name { get; set; } = ""; }
`
      );
      fs.writeFileSync(
        path.join(srcDir, 'Service.cs'),
        `using System.Threading.Tasks;
namespace MyApp;
public class DataExporter
{
  public SessionInfoDto Build(UserDto user, SessionInfoDto session) { return session; }
  public Task<SessionInfoDto> BuildAsync(UserDto user) { return Task.FromResult(new SessionInfoDto()); }
  public SessionInfoDto Latest { get; set; } = new();
  private UserDto _cached;
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const sessionDto = scope.cg
        .getNodesByKind('class')
        .find((n) => n.name === 'SessionInfoDto');
      const userDto = scope.cg
        .getNodesByKind('class')
        .find((n) => n.name === 'UserDto');
      expect(sessionDto).toBeDefined();
      expect(userDto).toBeDefined();

      const sessionIncoming = scope.cg
        .getIncomingEdges(sessionDto!.id)
        .filter((e) => e.kind === 'references');
      const userIncoming = scope.cg
        .getIncomingEdges(userDto!.id)
        .filter((e) => e.kind === 'references');

      // SessionInfoDto: Build return, Build param, BuildAsync return (inside Task<>), Latest property.
      // UserDto: Build param, BuildAsync param, _cached field.
      expect(sessionIncoming.length).toBeGreaterThanOrEqual(4);
      expect(userIncoming.length).toBeGreaterThanOrEqual(3);
    });

    it('C# primary-constructor parameters record their type dependencies (#237)', async () => {
      // C# 12 primary constructors declare a type's injected dependencies inline
      // (`class Svc(IRepo repo, [FromKeyedServices("k")] ICache cache)`). Each
      // ctor parameter's type is recorded as a `references` edge from the class,
      // so a DI-registered contract reached only through a primary ctor is no
      // longer reported as having no dependents.
      fs.mkdirSync(path.join(scope.tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src', 'Contracts.cs'),
        `namespace App;
public interface IRepo { }
public class ICache { }
`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src', 'OrderService.cs'),
        `namespace App;
public sealed class OrderService(IRepo repo, [FromKeyedServices("primary")] ICache cache)
{
  public void Run() { }
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const svc = scope.cg.getNodesByKind('class').find((n) => n.name === 'OrderService');
      expect(svc).toBeDefined();
      // The class itself must index (it used to vanish under the old grammar).
      const out = scope.cg.getOutgoingEdges(svc!.id).filter((e) => e.kind === 'references');
      const depNames = out.map((e) => scope.cg.getNode(e.target)?.name);
      expect(depNames).toContain('IRepo');
      expect(depNames).toContain('ICache'); // the keyed-DI ([FromKeyedServices]) dependency
    });

    it('Go: leaves stdlib calls (fmt.Println, etc.) external', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.go'),
        `package main

import "fmt"

func main() {
  fmt.Println("hi")
}
`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });

      const mainFn = scope.cg.getNodesByKind('function').filter((n) => n.name === 'main')[0];
      const calls = scope.cg.getOutgoingEdges(mainFn!.id).filter((e) => e.kind === 'calls');
      // No spurious in-project edge — fmt.* must stay unresolved/external.
      expect(calls).toHaveLength(0);
    });
  });

}
