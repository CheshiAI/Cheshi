import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerInstantiatesDecoratesEdgeExtractionTests(): void {


  describe('Instantiates + Decorates edge extraction', () => {
    it('emits an instantiates ref for `new Foo()`', () => {
      const code = `
class Foo {}
function bootstrap() { return new Foo(); }
`;
      const result = extractFromSource('app.ts', code);
      const ref = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'instantiates' && r.referenceName === 'Foo'
      );
      expect(ref).toBeDefined();
    });

    it('strips type-argument suffix from generic constructors', () => {
      const code = `
class Container<T> { constructor(_: T) {} }
function go() { return new Container<string>('x'); }
`;
      const result = extractFromSource('app.ts', code);
      const ref = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'instantiates'
      );
      expect(ref).toBeDefined();
      // Container<string> must be normalised to "Container" — otherwise
      // resolution can never match the class node.
      expect(ref!.referenceName).toBe('Container');
    });

    it('keeps trailing identifier from qualified `new ns.Foo()`', () => {
      const code = `
const ns = { Foo: class {} };
function go() { return new ns.Foo(); }
`;
      const result = extractFromSource('app.ts', code);
      const ref = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'instantiates'
      );
      // We can't always resolve which Foo, but the name should be the
      // simple identifier so name-matching has a chance.
      expect(ref?.referenceName).toBe('Foo');
    });

    it('emits a decorates ref for `@Foo class X {}`', () => {
      const code = `
function Foo(_arg: string) { return (cls: any) => cls; }
@Foo('x')
class X {}
`;
      const result = extractFromSource('app.ts', code);
      const decorClass = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'decorates' && r.referenceName === 'Foo'
      );
      expect(decorClass).toBeDefined();
    });

    it('does NOT attribute a prior class\'s decorator to the next class', () => {
      // Regression: the sibling-walk must stop at the first non-
      // decorator separator. `@A class Foo {} @B class Bar {}` must
      // produce `decorates(Foo, A)` and `decorates(Bar, B)` — never
      // `decorates(Bar, A)`.
      const code = `
function A(cls: any) { return cls; }
function B(cls: any) { return cls; }
@A
class Foo {}
@B
class Bar {}
`;
      const result = extractFromSource('app.ts', code);
      const decoratesEdges = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'decorates'
      );
      // Exactly one decorates ref per decorated class, no cross-attribution.
      const fromBar = decoratesEdges.filter((r) =>
        result.nodes.find((n) => n.id === r.fromNodeId && n.name === 'Bar')
      );
      expect(fromBar.length).toBe(1);
      expect(fromBar[0]!.referenceName).toBe('B');
    });

    it('emits a decorates ref for `@Foo method() {}`', () => {
      const code = `
function Get(p: string) { return (t: any, k: string) => t; }
class Svc {
  @Get('/x') method() { return 1; }
}
`;
      const result = extractFromSource('app.ts', code);
      const decorMethod = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'decorates' && r.referenceName === 'Get'
      );
      expect(decorMethod).toBeDefined();
      // The decorated symbol must be `method`, not the constructor or class.
      const decoratedNode = result.nodes.find((n) => n.id === decorMethod!.fromNodeId);
      expect(decoratedNode?.name).toBe('method');
    });
  });
}
