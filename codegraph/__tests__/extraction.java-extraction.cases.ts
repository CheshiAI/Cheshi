import { extractFromSource } from '../src/extraction';
import { describe, expect, it } from 'bun:test';

export function registerJavaExtractionTests(): void {


  describe('Java Extraction', () => {
    it('should extract class declarations', () => {
      const code = `
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public User getUser(String id) {
        return repository.findById(id);
    }
}
`;
      const result = extractFromSource('UserService.java', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('UserService');
      expect(classNode?.visibility).toBe('public');
    });

    it('should extract method declarations', () => {
      const code = `
public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
      const result = extractFromSource('Calculator.java', code);

      const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'add');
      expect(methodNode).toBeDefined();
      expect(methodNode?.isStatic).toBe(true);
    });

    it('wraps top-level declarations in a namespace from package_declaration', () => {
      const code = `
package com.example.foo;

public class Bar {
    public String greet() { return "hi"; }
}
`;
      const result = extractFromSource('Bar.java', code);

      const ns = result.nodes.find((n) => n.kind === 'namespace');
      expect(ns?.name).toBe('com.example.foo');

      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
      expect(cls?.qualifiedName).toBe('com.example.foo::Bar');

      const greet = result.nodes.find((n) => n.kind === 'method' && n.name === 'greet');
      expect(greet?.qualifiedName).toBe('com.example.foo::Bar::greet');
    });

    it('does not wrap when no package is declared', () => {
      const code = `
public class Bar {
    public String greet() { return "hi"; }
}
`;
      const result = extractFromSource('Bar.java', code);
      expect(result.nodes.find((n) => n.kind === 'namespace')).toBeUndefined();
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
      expect(cls?.qualifiedName).toBe('Bar');
    });

    it('extracts anonymous-class overrides from `new T() { ... }`', () => {
      // The pattern that breaks the trace through `strategy.foo()` in
      // libraries like guava's Splitter: the lambda-returned anonymous
      // class overrides abstract methods on the base, but without
      // extracting those overrides the interface→impl synthesizer has
      // nothing to bridge.
      const code = `
package com.example;

abstract class Base {
  abstract int compute(int x);
}

public class Factory {
  public Base make() {
    return new Base() {
      @Override
      int compute(int x) { return x + 1; }
    };
  }
}
`;
      const result = extractFromSource('Factory.java', code);

      const anon = result.nodes.find((n) => n.kind === 'class' && /Base\$anon@/.test(n.name));
      expect(anon, 'anonymous Base subclass should be extracted as a class').toBeDefined();

      const compute = result.nodes.find(
        (n) => n.kind === 'method' && n.name === 'compute' && n.qualifiedName.includes('$anon@')
      );
      expect(compute, 'override method should be a method on the anon class').toBeDefined();
      expect(compute!.qualifiedName).toContain('Factory::make::<Base$anon@');
      expect(compute!.qualifiedName.endsWith('::compute')).toBe(true);

      // Anon class must extend Base so Phase 5.5 (interface-impl) can bridge.
      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends' && r.referenceName === 'Base' && r.fromNodeId === anon!.id
      );
      expect(extendsRef, 'anon class should carry an `extends Base` reference').toBeDefined();

      // The enclosing `make` method still emits an instantiates edge to Base —
      // anon extraction must not swallow that signal.
      const instantiatesRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'instantiates' && r.referenceName === 'Base'
      );
      expect(instantiatesRef, 'enclosing method should still instantiate Base').toBeDefined();
    });

    it('extracts anonymous-class overrides inside a lambda body', () => {
      // The exact guava pattern: a lambda is passed to a constructor, and the
      // lambda body returns `new T() { @Override ... }`. The anon class must
      // still surface even though it sits inside a lambda_expression node.
      const code = `
package com.example;

interface Strategy {
  java.util.Iterator<String> iterator(String s);
}

abstract class BaseIter implements java.util.Iterator<String> {
  abstract int separatorStart(int start);
}

public class Splitter {
  private final Strategy strategy;
  public Splitter(Strategy s) { this.strategy = s; }

  public static Splitter on(char c) {
    return new Splitter((seq) ->
        new BaseIter() {
          @Override
          int separatorStart(int start) { return start + 1; }
          @Override public boolean hasNext() { return false; }
          @Override public String next() { return null; }
        });
  }
}
`;
      const result = extractFromSource('Splitter.java', code);

      const anon = result.nodes.find((n) => n.kind === 'class' && /BaseIter\$anon@/.test(n.name));
      expect(anon, 'anon BaseIter inside the lambda body should be extracted').toBeDefined();

      const sepStart = result.nodes.find(
        (n) =>
          n.kind === 'method' &&
          n.name === 'separatorStart' &&
          n.qualifiedName.includes('$anon@')
      );
      expect(sepStart, 'override inside the lambda-returned anon class should be a method node').toBeDefined();
    });
  });
}
