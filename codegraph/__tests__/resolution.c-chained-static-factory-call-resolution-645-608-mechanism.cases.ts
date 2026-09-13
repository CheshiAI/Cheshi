import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';

export function registerCChainedStaticFactoryCallResolution645608MechanismTests(scope: {
  cg: CodeGraph;
  tempDir: string;
}): void {


  describe('C# chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = scope.cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => scope.cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo.Create().Bar() via the factory return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named Bar() — it must never win the chain.
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.cs'),
        `class Aaa { void Bar() {} }
class Foo {
    static Foo Create() { return new Foo(); }
    void Bar() {}
}
class Caller {
    void Run() { Foo.Create().Bar(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::Bar')).toEqual(['Run']);
      expect(callerNamesOf('Aaa::Bar')).toEqual([]);
    });

    it('resolves a factory chain that passes arguments — Foo.Make(cfg).Build()', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.cs'),
        `class Config {}
class Foo {
    static Foo Make(Config c) { return new Foo(); }
    void Build() {}
}
class Caller {
    void Run() { Foo.Make(new Config()).Build(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::Build')).toEqual(['Run']);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.cs'),
        `class Foo {
    static Foo Create() { return new Foo(); }
}
class Other { void OnlyOther() {} }
class Caller {
    void Run() { Foo.Create().OnlyOther(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Foo has no OnlyOther() — must not mis-attach to the same-named Other::OnlyOther.
      expect(callerNamesOf('Other::OnlyOther')).toEqual([]);
    });
  });


  describe('Swift chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = scope.cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => scope.cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo.make().draw() via the factory return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named draw() — without the fix Swift dropped
      // the receiver to a bare `draw` and attached to Aaa (a wrong edge).
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.swift'),
        `class Aaa { func draw() {} }
class Foo {
    static func make() -> Foo { return Foo() }
    func draw() {}
}
func runCaller() { Foo.make().draw() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::draw')).toEqual(['runCaller']);
      expect(callerNamesOf('Aaa::draw')).toEqual([]);
    });

    it('resolves a constructor chain Foo().draw() and an args factory chain Foo.build(c).render()', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.swift'),
        `class Config {}
class Foo {
    static func build(_ c: Config) -> Foo { return Foo() }
    func draw() {}
    func render() {}
}
func runCaller() {
    Foo().draw()
    Foo.build(Config()).render()
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::draw')).toEqual(['runCaller']);
      expect(callerNamesOf('Foo::render')).toEqual(['runCaller']);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.swift'),
        `class Foo {
    static func make() -> Foo { return Foo() }
}
class Other { func onlyOther() {} }
func runCaller() { Foo.make().onlyOther() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Foo has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });


  describe('Chained call resolves a method on a supertype (conformance, #750)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = scope.cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => scope.cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves a chained method defined only on a SUPERCLASS the return type extends', async () => {
      // draw() lives on Base; Widget (the factory's return type) has no draw() of
      // its own. Decoy.draw must never win. Needs the conformance second pass.
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.java'),
        `class Base { void draw() {} }
class Widget extends Base {}
class Decoy { void draw() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller {
    void run() { Factory.create().draw(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Base::draw')).toEqual(['run']);
      expect(callerNamesOf('Decoy::draw')).toEqual([]);
    });

    it('resolves a chained method defined on an INTERFACE the return type implements (default method)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.java'),
        `interface Drawable { default void draw() {} }
class Widget implements Drawable {}
class Decoy { void draw() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller {
    void run() { Factory.create().draw(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Drawable::draw')).toEqual(['run']);
      expect(callerNamesOf('Decoy::draw')).toEqual([]);
    });

    it('still creates NO edge when no supertype has the method (safety preserved)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.java'),
        `class Base {}
class Widget extends Base {}
class Other { void onlyOther() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller {
    void run() { Factory.create().onlyOther(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Neither Widget nor Base has onlyOther() — must not attach to Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });


  describe('Rust chained associated-function call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = scope.cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => scope.cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo::new().bar() (and a Self return) via the associated fn, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.rs'),
        `struct Aaa { _x: i32 }
impl Aaa { fn bar(&self) {} }
struct Foo { _x: i32 }
impl Foo {
    fn new() -> Foo { Foo { _x: 0 } }
    fn make() -> Self { Foo { _x: 0 } }
    fn bar(&self) {}
}
fn caller() {
    Foo::new().bar();
    Foo::make().bar();
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::bar')).toEqual(['caller']);
      expect(callerNamesOf('Aaa::bar')).toEqual([]);
    });

    it('resolves a chain that passes arguments — Foo::with(c).build()', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.rs'),
        `struct Config;
struct Foo { _x: i32 }
impl Foo {
    fn with(c: Config) -> Foo { Foo { _x: 0 } }
    fn build(&self) {}
}
fn caller() { Foo::with(Config).build(); }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::build')).toEqual(['caller']);
    });

    it('resolves a chained method from a trait the type implements (default method, via conformance)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.rs'),
        `struct Foo { _x: i32 }
impl Foo { fn new() -> Foo { Foo { _x: 0 } } }
struct Decoy { _x: i32 }
impl Decoy { fn draw(&self) {} }
trait Drawable { fn draw(&self) {} }
impl Drawable for Foo {}
fn caller() { Foo::new().draw(); }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Drawable::draw')).toEqual(['caller']);
      expect(callerNamesOf('Decoy::draw')).toEqual([]);
    });

    it('creates NO edge when neither the type nor a supertype has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.rs'),
        `struct Foo { _x: i32 }
impl Foo { fn new() -> Foo { Foo { _x: 0 } } }
struct Other { _x: i32 }
impl Other { fn only_other(&self) {} }
fn caller() { Foo::new().only_other(); }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Foo has no only_other() — must not mis-attach to the same-named Other::only_other.
      expect(callerNamesOf('Other::only_other')).toEqual([]);
    });
  });


  describe('Go chained factory-function call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = scope.cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => scope.cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves New().Bar() via the factory return type (pointer), never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.go'),
        `package main
type Aaa struct{}
func (a *Aaa) Bar() {}
type Foo struct{}
func New() *Foo { return &Foo{} }
func (f *Foo) Bar() {}
func caller() { New().Bar() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::Bar')).toEqual(['caller']);
      expect(callerNamesOf('Aaa::Bar')).toEqual([]);
    });

    it('resolves an args chain and a multi-return factory — With(c).Build(), (*Foo, error)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.go'),
        `package main
type Config struct{}
type Foo struct{}
func With(c Config) (*Foo, error) { return &Foo{}, nil }
func (f *Foo) Build() {}
func caller() { With(Config{}).Build() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::Build')).toEqual(['caller']);
    });

    it('resolves a method provided by an embedded struct (via conformance)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.go'),
        `package main
type Base struct{}
func (b *Base) Embedded() {}
type Decoy struct{}
func (d *Decoy) Embedded() {}
type Widget struct{ Base }
func NewWidget() *Widget { return &Widget{} }
func caller() { NewWidget().Embedded() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Base::Embedded')).toEqual(['caller']);
      expect(callerNamesOf('Decoy::Embedded')).toEqual([]);
    });

    it('creates NO edge when neither the type nor an embedded type has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.go'),
        `package main
type Foo struct{}
func New() *Foo { return &Foo{} }
type Other struct{}
func (o *Other) OnlyOther() {}
func caller() { New().OnlyOther() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Foo has no OnlyOther() — must not mis-attach to the same-named Other::OnlyOther.
      expect(callerNamesOf('Other::OnlyOther')).toEqual([]);
    });

    it('falls back to bare-name resolution for a VARIABLE-inner chain without exploding the graph', async () => {
      // `engine` is a package-level VARIABLE holding a func value, not a factory
      // FUNCTION — so its return type can't be recovered and the chain falls back
      // to bare-name resolution of the method (restoring the pre-re-encoding edge).
      // Regression for the runaway this fallback originally caused: it resolved
      // with a mutated `original.referenceName` (the bare `ServeHTTP`, not the
      // stored `engine().ServeHTTP`), so the batched resolver's keyed delete
      // no-oped, the offset-0 batch never drained, and edges inserted forever
      // (5M edges / 1.4 GB on a 99-file repo). The fallback now ties the match to
      // the original ref, and a non-progress guard backstops the loop.
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.go'),
        `package main
type Server struct{}
func (s *Server) ServeHTTP() {}
var engine = func() *Server { return &Server{} }
func caller() { engine().ServeHTTP() }
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Recall: the variable-inner chain still finds the method by bare name.
      expect(callerNamesOf('Server::ServeHTTP')).toEqual(['caller']);
      // No runaway: a single call site yields a single edge, not millions.
      const target = scope.cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'Server::ServeHTTP')!;
      const rawCalls = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls');
      expect(rawCalls.length).toBeLessThan(5);
    });
  });


  describe('Scala chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = scope.cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = scope.cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => scope.cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves a companion-factory chain Foo.create().doIt() to the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.scala'),
        `object Foo {
  def create(): Bar = new Bar()
}
class Bar {
  def doIt(): Unit = {}
}
class Decoy {
  def doIt(): Unit = {}
}
object Main {
  def run(): Unit = { Foo.create().doIt() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a case-class apply construction Point(x).dist() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.scala'),
        `class Point(x: Int) {
  def dist(): Int = x
}
class Other {
  def dist(): Int = 0
}
object Main {
  def run(): Unit = { Point(3).dist() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Point::dist')).toEqual(['run']);
      expect(callerNamesOf('Other::dist')).toEqual([]);
    });

    it('resolves a chained method provided by a trait the return type extends (via conformance)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.scala'),
        `trait Base {
  def shared(): Unit = {}
}
class Widget extends Base
class Decoy {
  def shared(): Unit = {}
}
object Factory {
  def make(): Widget = new Widget()
}
object Main {
  def run(): Unit = { Factory.make().shared() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Base::shared')).toEqual(['run']);
      expect(callerNamesOf('Decoy::shared')).toEqual([]);
    });

    it('creates NO edge when neither the factory return type nor a supertype has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.scala'),
        `object Foo {
  def create(): Bar = new Bar()
}
class Bar {
}
class Other {
  def onlyOther(): Unit = {}
}
object Main {
  def run(): Unit = { Foo.create().onlyOther() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Bar has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

}
