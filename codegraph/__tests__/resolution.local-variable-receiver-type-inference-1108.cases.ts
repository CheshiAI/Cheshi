import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph, Node } from '../src';
import { ResolutionContext } from '../src/resolution';
import { matchReference } from '../src/resolution/name-matcher';

export function registerLocalVariableReceiverTypeInference1108Tests(scope: {
  tempDir: string;
  cg: CodeGraph;
}): void {


  describe('Local-variable receiver-type inference (#1108)', () => {
    // `lg.log()` where `lg` is a local whose type is inferred from its
    // declaration/initializer. Before this, only C++ resolved these; every
    // other language produced no method edge. Each case is one file with a
    // single Logger + a caller using a local-variable receiver — a correct
    // resolution makes the caller a caller of `log`.
    const cases: Array<{ lang: string; file: string; src: string }> = [
      {
        lang: 'TypeScript (= new T)', file: 'svc.ts',
        src: `class Logger { log() { return 1; } }\nexport function use() { const lg = new Logger(); return lg.log(); }\n`
      },
      {
        lang: 'JavaScript (= new T)', file: 'svc.js',
        src: `class Logger { log() { return 1; } }\nexport function use() { const lg = new Logger(); return lg.log(); }\n`
      },
      {
        lang: 'Python (= T())', file: 'svc.py',
        src: `class Logger:\n    def log(self):\n        return 1\ndef use():\n    lg = Logger()\n    return lg.log()\n`
      },
      {
        lang: 'Java (T x = new T)', file: 'Svc.java',
        src: `class Logger { void log() { int a = 1; } }\nclass Use { void run() { Logger lg = new Logger(); lg.log(); } }\n`
      },
      {
        lang: 'C# (var x = new T)', file: 'Svc.cs',
        src: `class Logger { void Log() { int a = 1; } }\nclass Use { void Run() { var lg = new Logger(); lg.Log(); } }\n`
      },
      {
        lang: 'Kotlin (val x = T())', file: 'Svc.kt',
        src: `class Logger { fun log(): Int { return 1 } }\nfun use(): Int { val lg = Logger(); return lg.log() }\n`
      },
      {
        lang: 'Swift (let x = T())', file: 'svc.swift',
        src: `class Logger { func log() -> Int { return 1 } }\nfunc use() -> Int { let lg = Logger(); return lg.log() }\n`
      },
      {
        lang: 'Go (x := T{})', file: 'svc.go',
        src: `package a\ntype Logger struct{}\nfunc (l Logger) Log() int { return 1 }\nfunc Use() int { lg := Logger{}; return lg.Log() }\n`
      },
      {
        lang: 'Rust (let x = T{})', file: 'svc.rs',
        src: `pub struct Logger { n: i32 }\nimpl Logger { pub fn log(&self) -> i32 { self.n } }\npub fn use_it() -> i32 { let lg = Logger { n: 1 }; lg.log() }\n`
      },
      {
        lang: 'Dart (var x = T())', file: 'svc.dart',
        src: `class Logger { int log() { return 1; } }\nint use() { var lg = Logger(); return lg.log(); }\n`
      },
      {
        lang: 'PHP ($x = new T)', file: 'svc.php',
        src: `<?php\nclass Logger { function log() { return 1; } }\nfunction useIt() { $lg = new Logger(); return $lg->log(); }\n`
      },
      {
        lang: 'Scala (val x = new T)', file: 'Svc.scala',
        src: `class Logger { def log(): Int = 1 }\nobject A { def use(): Int = { val lg = new Logger(); lg.log() } }\n`
      },
      {
        lang: 'Ruby (x = T.new)', file: 'svc.rb',
        src: `class Logger\n  def log\n    1\n  end\nend\ndef use\n  lg = Logger.new\n  lg.log\nend\n`
      },
      {
        lang: 'Lua (x = T.new(); x:log())', file: 'svc.lua',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:log() return 1 end\nlocal function use() local lg = Logger.new(); return lg:log() end\nreturn use\n`
      },
      {
        lang: 'Luau (x = T.new(); x:log())', file: 'svc.luau',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:log(): number return 1 end\nlocal function use(): number local lg = Logger.new(); return lg:log() end\nreturn use\n`
      },
      {
        lang: 'R (x <- T$new(); x$log())', file: 'svc.R',
        src: `Logger <- R6::R6Class("Logger", public = list(log = function() 1))\nuse <- function() { lg <- Logger$new(); lg$log() }\n`
      },
      {
        lang: 'Pascal (var x: T; x.Method)', file: 'svc.pas',
        src: `unit A;\ninterface\ntype TLogger = class function Log: Integer; end;\nimplementation\nfunction TLogger.Log: Integer; begin Result := 1; end;\nprocedure Use;\nvar lg: TLogger;\nbegin\n  lg := TLogger.Create;\n  lg.Log;\nend;\nend.\n`
      },
    ];

    for (const c of cases) {
      it(`resolves a local-variable method call — ${c.lang}`, async () => {
        fs.writeFileSync(path.join(scope.tempDir, c.file), c.src);
        scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
        scope.cg.resolveReferences();

        const logMethod = scope.cg
          .getNodesByKind('method')
          .find((n) => n.name.toLowerCase() === 'log');
        expect(logMethod, `${c.lang}: log method should be indexed`).toBeDefined();

        // The enclosing caller resolves through the local variable to `log`.
        const callers = scope.cg.getCallers(logMethod!.id).map((x) => x.node.name);
        expect(
          callers.length,
          `${c.lang}: log should have a caller (got [${callers.join(', ')}])`,
        ).toBeGreaterThan(0);
      });
    }

    it('Ruby: builds receiver.method and keeps Foo.new as an instantiation', async () => {
      // The Ruby extractor previously took the receiver as the callee and
      // dropped the method name (`lg.log()` -> a call to `lg`). Now it builds
      // `lg.log`, while `Logger.new` must still record an instantiation.
      fs.writeFileSync(
        path.join(scope.tempDir, 'svc.rb'),
        `class Logger\n  def log\n    1\n  end\nend\ndef run\n  lg = Logger.new\n  lg.log\nend\n`,
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const run = scope.cg.getNodesByKind('function').find((n) => n.name === 'run')!;
      const logMethod = scope.cg.getNodesByKind('method').find((n) => n.name === 'log')!;
      const logger = scope.cg.getNodesByKind('class').find((n) => n.name === 'Logger')!;
      const out = scope.cg.getOutgoingEdges(run.id);

      // lg.log resolved to the method (the receiver-type inference kicked in).
      expect(out.some((e) => e.kind === 'calls' && e.target === logMethod.id)).toBe(true);
      // Logger.new is still an instantiation of the class.
      expect(out.some((e) => e.kind === 'instantiates' && e.target === logger.id)).toBe(true);
    });

    it('TypeScript: infers a typed-parameter receiver, disambiguating same-named methods (#1125)', async () => {
      // A typed function parameter used as a receiver — `function use(lg: Logger)`
      // — never matched the old TS/JS pattern (it required a const|let|var
      // prefix), so `lg.log()` fell through to no edge once a second class shared
      // the method name. Two ambiguous classes are load-bearing here: a
      // single-class version resolves via a same-name fallback even without
      // inference, so only the collision proves type inference actually fired.
      fs.writeFileSync(
        path.join(scope.tempDir, 'svc.ts'),
        `class Logger { log() { return 1; } }\n` +
        `class Other { log() { return 2; } }\n` +
        `export function use(lg: Logger) { return lg.log(); }\n` +
        `export function useOther(o: Other) { return o.log(); }\n`,
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const classes = scope.cg.getNodesByKind('class');
      const logger = classes.find((n) => n.name === 'Logger')!;
      const other = classes.find((n) => n.name === 'Other')!;
      const logs = scope.cg.getNodesByKind('method').filter((n) => n.name === 'log');
      expect(logs.length, 'both log methods should be indexed').toBe(2);

      // Associate each same-named `log` with its class by line containment.
      const inClass = (m: (typeof logs)[number], c: typeof logger) =>
        m.startLine >= c.startLine && m.startLine <= (c.endLine ?? c.startLine);
      const loggerLog = logs.find((m) => inClass(m, logger))!;
      const otherLog = logs.find((m) => inClass(m, other))!;
      expect(loggerLog, "Logger's log").toBeDefined();
      expect(otherLog, "Other's log").toBeDefined();

      const loggerCallers = scope.cg.getCallers(loggerLog.id).map((x) => x.node.name);
      const otherCallers = scope.cg.getCallers(otherLog.id).map((x) => x.node.name);

      // Each typed-param call routes to its OWN class's method, not the other's.
      expect(loggerCallers).toContain('use');
      expect(loggerCallers).not.toContain('useOther');
      expect(otherCallers).toContain('useOther');
      expect(otherCallers).not.toContain('use');
    });

    // The same typed-parameter gap existed in every language whose pattern set
    // only matched keyword-anchored locals (let/var/:=/= new), not the bare
    // parameter form — Rust, Go, Dart, PHP (#1125). Each case: two classes
    // sharing a method name + two functions taking one as a typed param; a
    // correct fix routes each call to its OWN type's method (the collision is
    // load-bearing — a single class resolves via the same-name fallback either
    // way). Method↔type association is by qualifiedName, robust where the method
    // lives outside the type's line range (Rust `impl`, Go method decl).
    const typedParamCases: Array<{
      lang: string; file: string; method: string; callerA: string; callerB: string; src: string;
    }> = [
        {
          lang: 'Rust (fn f(x: &T))', file: 'svc.rs', method: 'log', callerA: 'use_it', callerB: 'use_other',
          src: `pub struct Logger { n: i32 }\nimpl Logger { pub fn log(&self) -> i32 { self.n } }\npub struct Other { n: i32 }\nimpl Other { pub fn log(&self) -> i32 { self.n } }\npub fn use_it(lg: &Logger) -> i32 { lg.log() }\npub fn use_other(o: &Other) -> i32 { o.log() }\n`
        },
        {
          lang: 'Go (func f(x T))', file: 'svc.go', method: 'Log', callerA: 'UseIt', callerB: 'UseOther',
          src: `package a\ntype Logger struct{}\nfunc (l Logger) Log() int { return 1 }\ntype Other struct{}\nfunc (o Other) Log() int { return 2 }\nfunc UseIt(lg Logger) int { return lg.Log() }\nfunc UseOther(o Other) int { return o.Log() }\n`
        },
        {
          lang: 'Dart (T f(U x))', file: 'svc.dart', method: 'log', callerA: 'useIt', callerB: 'useOther',
          src: `class Logger { int log() { return 1; } }\nclass Other { int log() { return 2; } }\nint useIt(Logger lg) { return lg.log(); }\nint useOther(Other o) { return o.log(); }\n`
        },
        {
          lang: 'PHP (f(T $x))', file: 'svc.php', method: 'log', callerA: 'useIt', callerB: 'useOther',
          src: `<?php\nclass Logger { function log() { return 1; } }\nclass Other { function log() { return 2; } }\nfunction useIt(Logger $lg) { return $lg->log(); }\nfunction useOther(Other $o) { return $o->log(); }\n`
        },
      ];

    for (const c of typedParamCases) {
      it(`infers a typed-parameter receiver, disambiguating same-named methods — ${c.lang} (#1125)`, async () => {
        fs.writeFileSync(path.join(scope.tempDir, c.file), c.src);
        scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
        scope.cg.resolveReferences();

        const methods = scope.cg.getNodesByKind('method').filter((n) => n.name === c.method);
        expect(methods.length, `${c.lang}: both ${c.method} methods indexed`).toBe(2);

        const loggerLog = methods.find((m) => /Logger/.test(m.qualifiedName ?? ''));
        const otherLog = methods.find((m) => /Other/.test(m.qualifiedName ?? ''));
        expect(loggerLog, `${c.lang}: Logger's ${c.method}`).toBeDefined();
        expect(otherLog, `${c.lang}: Other's ${c.method}`).toBeDefined();

        const loggerCallers = scope.cg.getCallers(loggerLog!.id).map((x) => x.node.name);
        const otherCallers = scope.cg.getCallers(otherLog!.id).map((x) => x.node.name);

        expect(loggerCallers, `${c.lang}: Logger callers`).toContain(c.callerA);
        expect(loggerCallers, `${c.lang}: Logger callers`).not.toContain(c.callerB);
        expect(otherCallers, `${c.lang}: Other callers`).toContain(c.callerB);
        expect(otherCallers, `${c.lang}: Other callers`).not.toContain(c.callerA);
      });
    }

    // Lua/Luau: a PascalCase method call (`lg:Log()`, the Roblox convention)
    // is the identical `receiver:Name` shape as a Luau type annotation, so it
    // self-matched the annotation pattern on the call's own line and inferred
    // "type = Log" (#1124). Two things are load-bearing in these fixtures:
    // the declaration sits on an EARLIER line than the call (on one line,
    // pattern order resolves it — the `.new` pattern wins first), and TWO
    // classes share the method name (a single class resolves via the
    // same-name fallback even when inference misfires). Luau's `useLogger`
    // takes a typed param instead of calling `.new()`, pinning that the
    // gated pattern still matches a genuine annotation.
    const pascalMethodCases: Array<{ lang: string; file: string; src: string }> = [
      {
        lang: 'Lua', file: 'svc.lua',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:Log() return 1 end\n\nlocal Other = {}\nOther.__index = Other\nfunction Other.new() return setmetatable({}, Other) end\nfunction Other:Log() return 2 end\n\nlocal function useLogger()\n\tlocal lg = Logger.new()\n\treturn lg:Log()\nend\n\nlocal function useOther()\n\tlocal o = Other.new()\n\treturn o:Log()\nend\n\nreturn useLogger, useOther\n`
      },
      {
        lang: 'Luau', file: 'svc.luau',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:Log(): number return 1 end\n\nlocal Other = {}\nOther.__index = Other\nfunction Other.new() return setmetatable({}, Other) end\nfunction Other:Log(): number return 2 end\n\nlocal function useLogger(lg: Logger): number\n\treturn lg:Log()\nend\n\nlocal function useOther(): number\n\tlocal o = Other.new()\n\treturn o:Log()\nend\n\nreturn useLogger, useOther\n`
      },
    ];

    for (const c of pascalMethodCases) {
      it(`resolves a PascalCase method call without self-matching the annotation pattern — ${c.lang} (#1124)`, async () => {
        fs.writeFileSync(path.join(scope.tempDir, c.file), c.src);
        scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
        scope.cg.resolveReferences();

        const methods = scope.cg.getNodesByKind('method').filter((n) => n.name === 'Log');
        expect(methods.length, `${c.lang}: both Log methods indexed`).toBe(2);

        const loggerLog = methods.find((m) => /Logger/.test(m.qualifiedName ?? ''));
        const otherLog = methods.find((m) => /Other/.test(m.qualifiedName ?? ''));
        expect(loggerLog, `${c.lang}: Logger's Log`).toBeDefined();
        expect(otherLog, `${c.lang}: Other's Log`).toBeDefined();

        const loggerCallers = scope.cg.getCallers(loggerLog!.id).map((x) => x.node.name);
        const otherCallers = scope.cg.getCallers(otherLog!.id).map((x) => x.node.name);

        expect(loggerCallers, `${c.lang}: Logger callers`).toContain('useLogger');
        expect(loggerCallers, `${c.lang}: Logger callers`).not.toContain('useOther');
        expect(otherCallers, `${c.lang}: Other callers`).toContain('useOther');
        expect(otherCallers, `${c.lang}: Other callers`).not.toContain('useLogger');
      });
    }
  });


  describe('Name Matcher: kind bias for new ref kinds', () => {
    const baseContext = (candidates: Node[]): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: (name) => candidates.filter((c) => c.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => true,
      readFile: () => null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    });

    it('prefers a class candidate over a function for `instantiates` refs', () => {
      // A class and a function share a name across the codebase.
      // Without the kind bias, the function (which gets the +25 `calls`
      // bonus historically applied to all candidates of that kind) would
      // win. Now the instantiates branch reverses it.
      const fn: Node = {
        id: 'func:utils.ts:Logger:5', kind: 'function', name: 'Logger',
        qualifiedName: 'utils.ts::Logger', filePath: 'utils.ts', language: 'typescript',
        startLine: 5, endLine: 7, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const cls: Node = {
        id: 'class:logger.ts:Logger:10', kind: 'class', name: 'Logger',
        qualifiedName: 'logger.ts::Logger', filePath: 'logger.ts', language: 'typescript',
        startLine: 10, endLine: 30, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'func:main.ts:bootstrap:1',
        referenceName: 'Logger',
        referenceKind: 'instantiates' as const,
        line: 5, column: 0, filePath: 'main.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([fn, cls]));
      expect(result?.targetNodeId).toBe('class:logger.ts:Logger:10');
    });

    it('prefers a function candidate over a non-function for `decorates` refs', () => {
      const variable: Node = {
        id: 'var:config.ts:Inject:5', kind: 'variable', name: 'Inject',
        qualifiedName: 'config.ts::Inject', filePath: 'config.ts', language: 'typescript',
        startLine: 5, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const decorator: Node = {
        id: 'func:di.ts:Inject:10', kind: 'function', name: 'Inject',
        qualifiedName: 'di.ts::Inject', filePath: 'di.ts', language: 'typescript',
        startLine: 10, endLine: 20, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'class:svc.ts:UserService:1',
        referenceName: 'Inject',
        referenceKind: 'decorates' as const,
        line: 5, column: 0, filePath: 'svc.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([variable, decorator]));
      expect(result?.targetNodeId).toBe('func:di.ts:Inject:10');
    });
  });


  describe('tsconfig path aliases', () => {
    it('resolves an aliased import to the alias-mapped file (not a same-named file elsewhere)', async () => {
      // Two same-named exports in different directories. Without alias
      // resolution, name-matcher would pick whichever it finds first;
      // with alias resolution, the import path uniquely picks one.
      fs.mkdirSync(path.join(scope.tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(scope.tempDir, 'src/legacy'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/utils/format.ts'),
        `export function pickMe(): number { return 1; }\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/legacy/format.ts'),
        `export function pickMe(): number { return 99; }\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/main.ts'),
        `import { pickMe } from '@utils/format';\nexport function go(): number { return pickMe(); }\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@utils/*': ['utils/*'] },
          },
        })
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      // The two pickMe nodes live in different files. The aliased
      // import should attach the call edge to the @utils-mapped one,
      // not the legacy duplicate.
      const all = scope.cg.getNodesByKind('function').filter((n) => n.name === 'pickMe');
      const utilsNode = all.find((n) => n.filePath === 'src/utils/format.ts');
      const legacyNode = all.find((n) => n.filePath === 'src/legacy/format.ts');
      expect(utilsNode).toBeDefined();
      expect(legacyNode).toBeDefined();

      const utilsCallers = scope.cg.getCallers(utilsNode!.id);
      const legacyCallers = scope.cg.getCallers(legacyNode!.id);
      expect(utilsCallers.length).toBeGreaterThan(0);
      expect(utilsCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      // The legacy node should NOT have a caller from src/main.ts —
      // the alias correctly picked the utils version.
      expect(legacyCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
    });

    it('falls back gracefully when tsconfig is absent', async () => {
      fs.mkdirSync(path.join(scope.tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/a.ts'),
        `export function aFn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/b.ts'),
        `import { aFn } from './a';\nexport function bFn(): void { aFn(); }\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // No tsconfig present — index should still complete and the
      // relative-import-based call edge should be created.
      const aFn = scope.cg.getNodesByKind('function').find((n) => n.name === 'aFn');
      expect(aFn).toBeDefined();
      const callers = scope.cg.getCallers(aFn!.id);
      expect(callers.some((c) => c.node.filePath === 'src/b.ts')).toBe(true);
    });
  });

}
