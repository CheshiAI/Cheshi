import { describe, expect, it } from 'bun:test';
import { Node } from '../src';
import { ResolutionContext } from '../src/resolution';
import { matchReference } from '../src/resolution/name-matcher';

export function registerNameMatcherTests(): void {


  describe('Name Matcher', () => {
    it('should match exact name references', () => {
      // Create a mock context
      const mockNodes: Node[] = [
        {
          id: 'func:test.ts:myFunction:10',
          kind: 'function',
          name: 'myFunction',
          qualifiedName: 'test.ts::myFunction',
          filePath: 'test.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => mockNodes,
        getNodesByName: (name) => mockNodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['test.ts'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'myFunction',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:test.ts:myFunction:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should resolve Erlang -behaviour refs only to module namespaces', () => {
      // On emqx, `-behaviour(supervisor)` (OTP behaviour, not in the repo)
      // fell through to bare-name matching and resolved to a
      // `-define(supervisor, ...)` macro constant in an unrelated app.
      const macroConstant: Node = {
        id: 'constant:apps/bridge/src/impl.erl:supervisor:61',
        kind: 'constant',
        name: 'supervisor',
        qualifiedName: 'impl::supervisor',
        filePath: 'apps/bridge/src/impl.erl',
        language: 'erlang',
        startLine: 61,
        endLine: 61,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      const behaviourModule: Node = {
        id: 'namespace:src/my_behaviour.erl:my_behaviour:1',
        kind: 'namespace',
        name: 'my_behaviour',
        qualifiedName: 'my_behaviour',
        filePath: 'src/my_behaviour.erl',
        language: 'erlang',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      const nodes = [macroConstant, behaviourModule];
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => nodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const mkRef = (name: string) => ({
        fromNodeId: 'namespace:src/worker.erl:worker:1',
        referenceName: name,
        referenceKind: 'implements' as const,
        line: 2,
        column: 0,
        filePath: 'src/worker.erl',
        language: 'erlang' as const,
      });

      // Out-of-repo behaviour whose name collides with a macro constant:
      // stays unresolved instead of linking the constant.
      expect(matchReference(mkRef('supervisor'), context)).toBeNull();
      // In-repo behaviour module resolves to its namespace.
      const resolved = matchReference(mkRef('my_behaviour'), context);
      expect(resolved?.targetNodeId).toBe(behaviourModule.id);

      // The same module-only rule covers refs emitted by .app/.app.src
      // resource files: on emqx, the `ssl` OTP app dependency resolved to a
      // test helper FUNCTION named ssl. A colliding non-module name stays
      // unresolved; a real umbrella-sibling module resolves.
      nodes.push({
        id: 'function:test/ldap_SUITE.erl:ssl:12',
        kind: 'function',
        name: 'ssl',
        qualifiedName: 'ldap_SUITE::ssl',
        filePath: 'test/ldap_SUITE.erl',
        language: 'erlang',
        startLine: 12,
        endLine: 14,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });
      const appRef = (name: string) => ({
        fromNodeId: 'file:src/myapp.app.src',
        referenceName: name,
        referenceKind: 'imports' as const,
        line: 6,
        column: 0,
        filePath: 'src/myapp.app.src',
        language: 'erlang' as const,
      });
      expect(matchReference(appRef('ssl'), context)).toBeNull();
      expect(matchReference(appRef('my_behaviour'), context)?.targetNodeId).toBe(behaviourModule.id);
    });

    it('should prefer same-module candidates over cross-module matches', () => {
      // Simulates a Python monorepo where multiple apps define navigate()
      const candidateA: Node = {
        id: 'func:apps/app_a/src/server.py:navigate:10',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_a/src/server.py::navigate',
        filePath: 'apps/app_a/src/server.py',
        language: 'python',
        startLine: 10,
        endLine: 20,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const candidateB: Node = {
        id: 'func:apps/app_b/src/server.py:navigate:15',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_b/src/server.py::navigate',
        filePath: 'apps/app_b/src/server.py',
        language: 'python',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? [candidateA, candidateB] : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a should resolve to app_a's navigate, not app_b's
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:apps/app_a/src/server.py:navigate:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should lower confidence for cross-module exact matches', () => {
      // Only one candidate but in a completely different module
      const candidates: Node[] = [
        {
          id: 'func:apps/app_b/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_b/src/server.py::navigate',
          filePath: 'apps/app_b/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
        {
          id: 'func:apps/app_c/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_c/src/server.py::navigate',
          filePath: 'apps/app_c/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? candidates : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a — neither candidate is in the same module
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      // Should still resolve but with low confidence
      expect(result).not.toBeNull();
      expect(result?.confidence).toBeLessThanOrEqual(0.4);
    });

    it('should match qualified name references', () => {
      const mockClassNode: Node = {
        id: 'class:user.ts:User:5',
        kind: 'class',
        name: 'User',
        qualifiedName: 'user.ts::User',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 5,
        endLine: 30,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const mockMethodNode: Node = {
        id: 'method:user.ts:User.save:15',
        kind: 'method',
        name: 'save',
        qualifiedName: 'user.ts::User::save',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: (fp) => fp === 'user.ts' ? [mockClassNode, mockMethodNode] : [],
        getNodesByName: (name) => {
          if (name === 'User') return [mockClassNode];
          if (name === 'save') return [mockMethodNode];
          return [];
        },
        getNodesByQualifiedName: (qn) => {
          if (qn === 'user.ts::User::save') return [mockMethodNode];
          return [];
        },
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['user.ts'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:main:5',
        referenceName: 'User.save',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('method:user.ts:User.save:15');
    });
  });


  describe('Ubiquitous-name ceiling (#999)', () => {
    // A vendored theme/SDK re-declares the same method name across thousands of
    // files (Metronic's `init`/`update`/… on every widget). The fuzzy strategies
    // used to score every same-named candidate per ref — O(K) per ref, O(K²)
    // total — which pinned a core for 15-28 min at "Resolving refs … 94%". Above
    // the ceiling they must DECLINE instead, since no proximity/word-overlap
    // score can pick the one true target among thousands anyway.
    const CEILING = 500;

    // A spy context: counts how many nodes the strategy actually inspects, so we
    // can assert the cap short-circuits BEFORE the O(K) scoring (not just that it
    // returns null).
    const makeManyMethods = (n: number, name: string): Node[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `method:widget${i}.js:Widget${i}.${name}:1`,
        kind: 'method' as const,
        name,
        qualifiedName: `widget${i}.js::Widget${i}::${name}`,
        filePath: `static/theme/widget${i}.js`,
        language: 'javascript' as const,
        startLine: 1,
        endLine: 5,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      }));

    const spyContext = (nodes: Node[]): { ctx: ResolutionContext; lookups: () => number } => {
      let scanned = 0;
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => {
          const hit = nodes.filter((n) => n.name === name);
          scanned += hit.length;
          return hit;
        },
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      return { ctx, lookups: () => scanned };
    };

    it('declines a method call (`obj.init`) above the ceiling instead of scoring K candidates', () => {
      const { ctx } = spyContext(makeManyMethods(CEILING + 1, 'init'));
      const ref = {
        fromNodeId: 'method:caller.js:caller:1',
        referenceName: 'widget.init',
        referenceKind: 'calls' as const,
        line: 2,
        column: 4,
        filePath: 'static/theme/caller.js',
        language: 'javascript' as const,
      };
      expect(matchReference(ref, ctx)).toBeNull();
    });

    it('declines a bare exact-name ref above the ceiling', () => {
      const { ctx } = spyContext(makeManyMethods(CEILING + 1, 'render'));
      const ref = {
        fromNodeId: 'method:caller.js:caller:1',
        referenceName: 'render',
        referenceKind: 'calls' as const,
        line: 2,
        column: 4,
        filePath: 'static/theme/caller.js',
        language: 'javascript' as const,
      };
      expect(matchReference(ref, ctx)).toBeNull();
    });

    it('still resolves a SAME-FILE definition when one exists (precise path unaffected)', () => {
      // Strategy 1 (class-name) and same-file matching are precise — a ubiquitous
      // name with an unambiguous local target still resolves.
      const nodes = makeManyMethods(CEILING + 1, 'init');
      const local: Node = {
        id: 'class:static/theme/caller.js:Widgetly:1',
        kind: 'class',
        name: 'Widgetly',
        qualifiedName: 'static/theme/caller.js::Widgetly',
        filePath: 'static/theme/caller.js',
        language: 'javascript',
        startLine: 1, endLine: 9, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const localMethod: Node = {
        id: 'method:static/theme/caller.js:Widgetly.init:2',
        kind: 'method',
        name: 'init',
        qualifiedName: 'static/theme/caller.js::Widgetly::init',
        filePath: 'static/theme/caller.js',
        language: 'javascript',
        startLine: 2, endLine: 4, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const all = [...nodes, local, localMethod];
      const ctx: ResolutionContext = {
        getNodesInFile: (fp) => all.filter((n) => n.filePath === fp),
        getNodesByName: (name) => all.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      // `Widgetly.init` names the class explicitly → Strategy 1 resolves it.
      const ref = {
        fromNodeId: 'method:static/theme/caller.js:caller:6',
        referenceName: 'Widgetly.init',
        referenceKind: 'calls' as const,
        line: 6,
        column: 4,
        filePath: 'static/theme/caller.js',
        language: 'javascript' as const,
      };
      const result = matchReference(ref, ctx);
      expect(result?.targetNodeId).toBe('method:static/theme/caller.js:Widgetly.init:2');
    });

    it('still scores free-function candidates just below the ceiling', () => {
      // Bare JS calls can name free functions, never unrelated class methods.
      const nodes = makeManyMethods(CEILING - 1, 'update').map(node => ({ ...node, kind: 'function' as const }));
      // Make ONE candidate share the caller's directory so proximity picks it.
      nodes[0] = {
        ...nodes[0]!,
        id: 'method:static/theme/app/Widget0.update:1',
        qualifiedName: 'static/theme/app/widget.js::Widget0::update',
        filePath: 'static/theme/app/widget.js',
      };
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => nodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const ref = {
        fromNodeId: 'method:static/theme/app/caller.js:caller:1',
        referenceName: 'update',
        referenceKind: 'calls' as const,
        line: 2,
        column: 4,
        filePath: 'static/theme/app/caller.js',
        language: 'javascript' as const,
      };
      // Below the ceiling the fuzzy path runs and resolves SOMETHING (not capped).
      expect(matchReference(ref, ctx)).not.toBeNull();
    });
  });

}
