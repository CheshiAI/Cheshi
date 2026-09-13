import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph, Node, UnresolvedReference } from '../src';
import type { UnresolvedRef } from '../src/resolution';
import { ResolutionContext } from '../src/resolution';
import { matchByQualifiedName, matchMethodCall, preferCallSiteFile, resolveMethodOnType } from '../src/resolution/name-matcher';
import { getCodeGraphState, getResolverState } from './helpers/internal-state';

export function registerSameNameMethodDisambiguation1079Tests(scope: {
  tempDir: string;
  cg: CodeGraph;
}): void {


  describe('Same-name method disambiguation (#1079)', () => {
    // resolveMethodOnType picks among several methods that share a
    // `Type::method` qualifiedName. The precedence is:
    //   1. preferredFqn (Java/Kotlin import — target is intentionally in
    //      ANOTHER file, #314),
    //   2. the call site's OWN file (language-agnostic, #1079),
    //   3. matches[0] (first-indexed) as a last resort.
    const methodNode = (
      id: string,
      filePath: string,
      language: Node['language'] = 'cpp',
      qualifiedName = 'Logger::log',
      name = 'log',
    ): Node => ({
      id, kind: 'method', name, qualifiedName, filePath, language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
    });
    const callRef = (filePath: string, language: Node['language'] = 'cpp'): UnresolvedRef => ({
      fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
      line: 2, column: 0, filePath, language,
    });
    const ctxFor = (candidates: Node[]): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: (name) => candidates.filter((c) => c.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    });

    it('prefers the definition in the call site\'s own file (#1079)', () => {
      // matches[0] is the a/ definition; the call comes from b/, so it must
      // resolve to b/ — not collapse onto the first-indexed match.
      const logA = methodNode('m:a', 'a/svc.cpp');
      const logB = methodNode('m:b', 'b/svc.cpp');
      const result = resolveMethodOnType(
        'Logger', 'log', callRef('b/svc.cpp'), ctxFor([logA, logB]), 0.9, 'instance-method',
      );
      expect(result?.targetNodeId).toBe('m:b');
    });

    it('lets an import FQN pin a cross-file target over the same-file preference (#314)', () => {
      // Java: two `Bar::doIt` in different packages. The import FQN pins the
      // alpha package; even though the call site lives in beta's file, the FQN
      // must win — the same-file preference runs only AFTER preferredFqn.
      const alpha = methodNode('m:alpha', 'com/example/alpha/Bar.java', 'java', 'Bar::doIt', 'doIt');
      const beta = methodNode('m:beta', 'com/example/beta/Bar.java', 'java', 'Bar::doIt', 'doIt');
      const result = resolveMethodOnType(
        'Bar', 'doIt', callRef('com/example/beta/Bar.java', 'java'),
        ctxFor([alpha, beta]), 0.9, 'instance-method', 'com.example.alpha.Bar',
      );
      expect(result?.targetNodeId).toBe('m:alpha');
    });

    it('falls back to the first match when nothing disambiguates', () => {
      // Call site is a third file: no FQN, no same-file candidate → matches[0].
      const logA = methodNode('m:a', 'a/svc.cpp');
      const logB = methodNode('m:b', 'b/svc.cpp');
      const result = resolveMethodOnType(
        'Logger', 'log', callRef('c/other.cpp'), ctxFor([logA, logB]), 0.9, 'instance-method',
      );
      expect(result?.targetNodeId).toBe('m:a');
    });

    it('resolves C++ calls end-to-end to same-named classes in different files (#1079)', async () => {
      // The exact repro from the issue: two files, each with its own
      // `Logger::log`. Before the fix both callers pointed at the first def.
      fs.mkdirSync(path.join(scope.tempDir, 'a'), { recursive: true });
      fs.mkdirSync(path.join(scope.tempDir, 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'a', 'svc.cpp'),
        `class Logger { public: void log() { int a = 1; } };\nvoid useA() { Logger lg; lg.log(); }\n`,
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'b', 'svc.cpp'),
        `class Logger { public: void log() { int b = 2; } };\nvoid useB() { Logger lg; lg.log(); }\n`,
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const logInDir = (dir: string) =>
        scope.cg.getNodesByKind('method').find(
          (n) => n.name === 'log' && n.filePath.replace(/\\/g, '/').endsWith(`${dir}/svc.cpp`),
        )!;
      const callTargets = (fnName: string) =>
        scope.cg
          .getOutgoingEdges(scope.cg.getNodesByKind('function').find((n) => n.name === fnName)!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => e.target);

      const logA = logInDir('a');
      const logB = logInDir('b');
      expect(logA).toBeDefined();
      expect(logB).toBeDefined();
      expect(logA.id).not.toBe(logB.id);

      // Each caller resolves to the Logger::log in its OWN file.
      expect(callTargets('useA')).toContain(logA.id);
      expect(callTargets('useB')).toContain(logB.id);
    });

    it('preferCallSiteFile puts same-file candidates first and is otherwise a no-op', () => {
      const a = methodNode('m:a', 'a/svc.cpp');
      const b = methodNode('m:b', 'b/svc.cpp');
      // Same-file first; the rest keep their original order (stable).
      expect(preferCallSiteFile([a, b], 'b/svc.cpp').map((n) => n.id)).toEqual(['m:b', 'm:a']);
      expect(preferCallSiteFile([a, b], 'a/svc.cpp').map((n) => n.id)).toEqual(['m:a', 'm:b']);
      // No same-file match → unchanged; <2 candidates → returned as-is.
      expect(preferCallSiteFile([a, b], 'c/other.cpp').map((n) => n.id)).toEqual(['m:a', 'm:b']);
      expect(preferCallSiteFile([a], 'z/none.cpp')).toHaveLength(1);
    });

    it('matchByQualifiedName prefers the same-file target when a qualified name is ambiguous (#1079)', () => {
      // Two `Logger::log` definitions; an explicit `Logger::log()` call from b/
      // must resolve to b/'s definition, not the first-indexed one.
      const a = methodNode('m:a', 'a/svc.cpp');
      const b = methodNode('m:b', 'b/svc.cpp');
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => [a, b].filter((n) => n.name === name),
        getNodesByQualifiedName: (q) => (q === 'Logger::log' ? [a, b] : []),
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'Logger::log', referenceKind: 'calls',
        line: 2, column: 0, filePath: 'b/svc.cpp', language: 'cpp',
      };
      expect(matchByQualifiedName(ref, ctx)?.targetNodeId).toBe('m:b');
    });

    it('resolves a static/class-receiver call to the class in the caller\'s file (#1079)', async () => {
      // `Logger.log()` — the receiver is the class NAME, so this routes through
      // the class-name-receiver strategy (not the C++ instance path). It was
      // file-blind across languages; verified here on TypeScript.
      fs.mkdirSync(path.join(scope.tempDir, 'a'), { recursive: true });
      fs.mkdirSync(path.join(scope.tempDir, 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'a', 'svc.ts'),
        `class Logger { static log() { return 1; } }\nexport function useA() { return Logger.log(); }\n`,
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'b', 'svc.ts'),
        `class Logger { static log() { return 2; } }\nexport function useB() { return Logger.log(); }\n`,
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const logInDir = (dir: string) =>
        scope.cg.getNodesByKind('method').find(
          (n) => n.name === 'log' && n.filePath.replace(/\\/g, '/').endsWith(`${dir}/svc.ts`),
        )!;
      const callTargets = (fnName: string) =>
        scope.cg
          .getOutgoingEdges(scope.cg.getNodesByKind('function').find((n) => n.name === fnName)!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => e.target);

      const logA = logInDir('a');
      const logB = logInDir('b');
      expect(logA?.id).not.toBe(logB?.id);
      expect(callTargets('useA')).toContain(logA.id);
      expect(callTargets('useB')).toContain(logB.id);
    });

    it('resolves an explicitly-qualified call to the definition in the caller\'s file (#1079)', async () => {
      // `Logger::log()` with two `Logger::log` definitions routes through the
      // qualified-name strategy, whose partial match previously picked the first.
      fs.mkdirSync(path.join(scope.tempDir, 'a'), { recursive: true });
      fs.mkdirSync(path.join(scope.tempDir, 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'a', 'svc.cpp'),
        `class Logger { public: static void log() { int a = 1; } };\nvoid useA() { Logger::log(); }\n`,
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'b', 'svc.cpp'),
        `class Logger { public: static void log() { int b = 2; } };\nvoid useB() { Logger::log(); }\n`,
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const logInDir = (dir: string) =>
        scope.cg.getNodesByKind('method').find(
          (n) => n.name === 'log' && n.filePath.replace(/\\/g, '/').endsWith(`${dir}/svc.cpp`),
        )!;
      const callTargets = (fnName: string) =>
        scope.cg
          .getOutgoingEdges(scope.cg.getNodesByKind('function').find((n) => n.name === fnName)!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => e.target);

      const logA = logInDir('a');
      const logB = logInDir('b');
      expect(logA?.id).not.toBe(logB?.id);
      expect(callTargets('useA')).toContain(logA.id);
      expect(callTargets('useB')).toContain(logB.id);
    });
  });


  describe('Watchdog-safe resolution on collision-heavy repos (#1122)', () => {
    // On a large Java-style repo, per-ref resolution cost is unbounded in the
    // worst case (a colliding method name whose candidate set misses the LRU
    // re-fetches tens of thousands of rows, and receiver inference re-splits
    // the whole source file). v1.2.0 yielded only every 500 refs, so a dense
    // pocket multiplied that cost past the #850 watchdog window and a VALID
    // `init` was SIGKILLed at "Resolving refs". These pin the three guards:
    // per-ref yield checkpoints, the (type, method) match memo, and the
    // per-file lines cache with its generated/minified-line skip.
    const methodNode = (
      id: string,
      filePath: string,
      qualifiedName: string,
      name: string,
      language: Node['language'] = 'typescript',
      kind: Node['kind'] = 'method',
    ): Node => ({
      id, kind, name, qualifiedName, filePath, language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
    });

    it('resolveMethodOnType consults the method-match memo and still disambiguates per call site', () => {
      const logA = methodNode('m:a', 'a/svc.ts', 'Logger::log', 'log');
      const logB = methodNode('m:b', 'b/svc.ts', 'Logger::log', 'log');
      const shared = [logA, logB]; // one cached array served to every caller
      let memoCalls = 0;
      let rawNameLookups = 0;
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => { rawNameLookups++; return shared; },
        getMethodMatches: () => { memoCalls++; return shared; },
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const refFrom = (filePath: string): UnresolvedRef => ({
        fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
        line: 2, column: 0, filePath, language: 'typescript',
      });

      // Both call sites read the SAME memoized array, yet each still resolves
      // to its own file — per-ref disambiguation runs after the memo (#1079).
      const fromA = resolveMethodOnType('Logger', 'log', refFrom('a/svc.ts'), ctx, 0.9, 'instance-method');
      const fromB = resolveMethodOnType('Logger', 'log', refFrom('b/svc.ts'), ctx, 0.9, 'instance-method');
      expect(fromA?.targetNodeId).toBe('m:a');
      expect(fromB?.targetNodeId).toBe('m:b');
      expect(memoCalls).toBe(2);
      expect(rawNameLookups).toBe(0); // memo bypasses the unbounded name fetch
    });

    it('the production resolver context memoizes method matches per (language, type, method)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'svc.ts'),
        `class Logger { log() { return 1; } }\nexport function use() { const lg = new Logger(); return lg.log(); }\n`,
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      const resolver = getCodeGraphState(scope.cg).resolver;
      const ctx = getResolverState(resolver).context;

      const first = ctx.getMethodMatches!('Logger', 'log', 'typescript');
      const second = ctx.getMethodMatches!('Logger', 'log', 'typescript');
      expect(first.map((n) => n.qualifiedName)).toEqual(['Logger::log']);
      // Same array instance = served from the memo, not recomputed.
      expect(second).toBe(first);

      resolver.clearCaches();
      const afterClear = ctx.getMethodMatches!('Logger', 'log', 'typescript');
      expect(afterClear).not.toBe(first);
      expect(afterClear.map((n) => n.qualifiedName)).toEqual(['Logger::log']);
    });

    it('resolveBatchYielding offers a yield checkpoint for every ref', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'a.ts'),
        `export function fnA() { return 1; }\nexport function fnB() { return fnA(); }\nexport function fnC() { return fnB(); }\n`,
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'b.ts'),
        `import { fnA } from './a';\nexport function fnD() { return fnA(); }\n`,
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      const resolver = getCodeGraphState(scope.cg).resolver;

      // `init({ index: true })` already ran resolution, so feed the batch
      // directly — resolveBatchYielding takes it as an argument; whether each
      // ref resolves is irrelevant to the checkpoint contract.
      const refs: UnresolvedReference[] = ['fnA', 'fnB', 'nosuchFn', 'fnA', 'alsoMissing'].map((name, i) => ({
        fromNodeId: `caller-${i}`,
        referenceName: name,
        referenceKind: 'calls',
        line: i + 1,
        column: 0,
        filePath: 'a.ts',
        language: 'typescript',
      }));

      let checkpoints = 0;
      const countingYield = async () => { checkpoints++; };
      const result = await getResolverState(resolver).resolveBatchYielding(refs, countingYield);

      // One checkpoint per ref: a pocket of pathologically slow refs can never
      // run more than ONE ref past the yield budget before the heartbeat gets
      // a window — the #1122 kill required 500.
      expect(checkpoints).toBe(refs.length);
      expect(result.stats.total).toBe(refs.length);
    });

    it('receiver inference reads lines through getFileLines when the context provides it', () => {
      const loggerClass = methodNode('c:logger', 'svc.ts', 'Logger', 'Logger', 'typescript', 'class');
      const logMethod = methodNode('m:log', 'svc.ts', 'Logger::log', 'log');
      const otherLog = methodNode('m:other', 'other.ts', 'Other::log', 'log');
      const byName: Record<string, Node[]> = {
        Logger: [loggerClass],
        log: [logMethod, otherLog], // ambiguous bare name → only inference can resolve
      };
      const lines = ['const lg = new Logger();', 'lg.log();'];
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => byName[name] ?? [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        // Reading the raw source must not be needed when lines are provided.
        readFile: () => { throw new Error('readFile must not be called when getFileLines exists'); },
        getFileLines: () => lines,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
        line: 2, column: 0, filePath: 'svc.ts', language: 'typescript',
      };
      expect(matchMethodCall(ref, ctx)?.targetNodeId).toBe('m:log');
    });

    it('receiver inference skips generated/minified lines instead of regex-scanning them', () => {
      const loggerClass = methodNode('c:logger', 'svc.ts', 'Logger', 'Logger', 'typescript', 'class');
      const logMethod = methodNode('m:log', 'svc.ts', 'Logger::log', 'log');
      const otherLog = methodNode('m:other', 'other.ts', 'Other::log', 'log');
      const byName: Record<string, Node[]> = {
        Logger: [loggerClass],
        log: [logMethod, otherLog],
      };
      const ctxWithLines = (lines: string[]): ResolutionContext => ({
        getNodesInFile: () => [],
        getNodesByName: (name) => byName[name] ?? [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getFileLines: () => lines,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      });
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
        line: 1, column: 0, filePath: 'svc.ts', language: 'typescript',
      };

      // Control: the declaration on a normal-length line resolves.
      const normal = matchMethodCall(ref, ctxWithLines(['const lg = new Logger(); lg.log();']));
      expect(normal?.targetNodeId).toBe('m:log');

      // The same declaration buried in a >10K-char generated/minified line is
      // skipped — no resolution, and no per-ref regex pass over the huge line.
      const minified = 'var pad="' + 'x'.repeat(10_000) + '";const lg = new Logger(); lg.log();';
      expect(matchMethodCall(ref, ctxWithLines([minified]))).toBeNull();
    });
  });

}
