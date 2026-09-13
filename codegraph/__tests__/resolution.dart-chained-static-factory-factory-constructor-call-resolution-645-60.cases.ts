import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';

export function registerDartChainedStaticFactoryFactoryConstructorCallResolution64560Tests(scope: {
  cg: CodeGraph;
  tempDir: string;
}): void {


  describe('Dart chained static-factory / factory-constructor call resolution (#645/#608 mechanism)', () => {
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

    it('resolves a static-factory chain Foo.makeBar().doIt() to the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Foo {
  static Bar makeBar() => Bar();
}
class Bar {
  void doIt() {}
}
class Decoy {
  void doIt() {}
}
void run() {
  Foo.makeBar().doIt();
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a named factory-constructor chain Foo.create().ship() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Foo {
  Foo._();
  factory Foo.create() => Foo._();
  void ship() {}
}
class Decoy {
  void ship() {}
}
void run() {
  Foo.create().ship();
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // The factory constructor `Foo.create` is now a node whose return type is Foo,
      // so `ship` resolves on Foo, not the same-named Decoy.
      expect(callerNamesOf('Foo::ship')).toEqual(['run']);
      expect(callerNamesOf('Decoy::ship')).toEqual([]);
    });

    it('resolves a constructor-receiver chain Bar().doIt() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Bar {
  void doIt() {}
}
class Decoy {
  void doIt() {}
}
void run() {
  Bar().doIt();
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a chained method inherited from a superclass the return type extends (via conformance)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Base {
  void render() {}
}
class Widget extends Base {
  static Widget make() => Widget();
}
class Decoy {
  void render() {}
}
void run() {
  Widget.make().render();
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Base::render')).toEqual(['run']);
      expect(callerNamesOf('Decoy::render')).toEqual([]);
    });

    it('creates NO edge when neither the factory return type nor a supertype has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Foo {
  static Bar makeBar() => Bar();
}
class Bar {
}
class Other {
  void onlyOther() {}
}
void run() {
  Foo.makeBar().onlyOther();
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Bar has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });

    it('still extracts a method tree-sitter misparses as a constructor (@override + record return)', async () => {
      // tree-sitter-dart misparses `@override (A, B) reduce()` — the annotation
      // swallows the record return type, so `reduce()` looks like a single-
      // identifier constructor_signature. It must NOT be skipped as an unnamed
      // ctor (its name doesn't match the class); its body call must attribute to
      // `reduce`, not the class.
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Base {}
class Action extends Base {
  Action({required int x});
  @override
  (int, String) reduce() {
    return (compute(), "y");
  }
  int compute() => 1;
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // reduce must be a node and its body call must resolve to Action::compute.
      expect(callerNamesOf('Action::compute')).toEqual(['reduce']);
    });

    it('keeps plain construction Foo() as instantiation, not a Foo::Foo method call', async () => {
      // The unnamed constructor is intentionally NOT extracted as a `Foo::Foo`
      // method, so `Foo(...)` resolves to the class (an `instantiates` edge),
      // never hijacked into a call to a phantom constructor method.
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.dart'),
        `class Widget {
  final int x;
  Widget(this.x);
}
void run() {
  Widget(3);
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // No Foo::Foo phantom method node.
      expect(scope.cg.getNodesByKind('method').some((n) => n.qualifiedName === 'Widget::Widget')).toBe(false);
      // The construction resolves to the class as an `instantiates` edge.
      const widget = scope.cg.getNodesByKind('class').find((n) => n.name === 'Widget')!;
      const incoming = scope.cg.getIncomingEdges(widget.id);
      expect(incoming.some((e) => e.kind === 'instantiates')).toBe(true);
    });
  });


  describe('Objective-C chained message-send call resolution (#645/#608 mechanism)', () => {
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

    it('resolves a chained message send [[Foo create] doIt] via the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.m'),
        `@interface Bar : NSObject
- (void)doIt;
@end
@implementation Bar
- (void)doIt {}
@end
@interface Decoy : NSObject
- (void)doIt;
@end
@implementation Decoy
- (void)doIt {}
@end
@interface Foo : NSObject
+ (Bar *)create;
@end
@implementation Foo
+ (Bar *)create { return nil; }
- (void)run { [[Foo create] doIt]; }
@end
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a chained message whose method is inherited from a superclass (via conformance)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.m'),
        `@interface Base : NSObject
- (void)render;
@end
@implementation Base
- (void)render {}
@end
@interface Widget : Base
@end
@implementation Widget
@end
@interface Decoy : NSObject
- (void)render;
@end
@implementation Decoy
- (void)render {}
@end
@interface Factory : NSObject
+ (Widget *)make;
@end
@implementation Factory
+ (Widget *)make { return nil; }
- (void)run { [[Factory make] render]; }
@end
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Base::render')).toEqual(['run']);
      expect(callerNamesOf('Decoy::render')).toEqual([]);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.m'),
        `@interface Bar : NSObject
@end
@implementation Bar
@end
@interface Other : NSObject
- (void)onlyOther;
@end
@implementation Other
- (void)onlyOther {}
@end
@interface Foo : NSObject
+ (Bar *)create;
@end
@implementation Foo
+ (Bar *)create { return nil; }
- (void)run { [[Foo create] onlyOther]; }
@end
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Bar has no onlyOther — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });

    it('resolves a singleton chain [[Cache shared] clearAll] whose factory returns nonnull instancetype', async () => {
      // The factory returns `nonnull instancetype` — the nullability qualifier must
      // be skipped (not captured AS the type), and an instancetype class-message
      // factory returns the receiver class, so clearAll resolves on Cache, never a
      // same-named decoy. (Regression for both: the captured-`nonnull` bug and the
      // ubiquitous `[[X alloc] init]` / singleton pattern.)
      fs.writeFileSync(
        path.join(scope.tempDir, 'main.m'),
        `@interface Cache : NSObject
+ (nonnull instancetype)shared;
- (void)clearAll;
@end
@implementation Cache
+ (nonnull instancetype)shared { return nil; }
- (void)clearAll {}
@end
@interface Decoy : NSObject
- (void)clearAll;
@end
@implementation Decoy
- (void)clearAll {}
@end
@interface Caller : NSObject
- (void)run;
@end
@implementation Caller
- (void)run { [[Cache shared] clearAll]; }
@end
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Cache::clearAll')).toEqual(['run']);
      expect(callerNamesOf('Decoy::clearAll')).toEqual([]);
    });
  });

}
