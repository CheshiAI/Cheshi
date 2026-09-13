import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection } from '../src';
import type { UnresolvedRef } from '../src/resolution';
import { isPhpIncludePathRef } from '../src/resolution/import-resolver';

export function registerPhpIncludeResolutionTests(scope: {
  cg: CodeGraph;
  tempDir: string;
}): void {


  describe('PHP Include Resolution', () => {
    it('isPhpIncludePathRef distinguishes include paths from namespace use (#660)', () => {
      const mk = (name: string, over: Partial<UnresolvedRef> = {}): UnresolvedRef => ({
        fromNodeId: 'f', referenceName: name, referenceKind: 'imports',
        line: 1, column: 0, filePath: 'x.php', language: 'php', ...over,
      });
      // include paths: contain a slash or a file extension
      expect(isPhpIncludePathRef(mk('lib.php'))).toBe(true);
      expect(isPhpIncludePathRef(mk('inc/db.php'))).toBe(true);
      expect(isPhpIncludePathRef(mk('../config.php'))).toBe(true);
      // namespace use symbols: a bare class (Closure) or FQN — never a path,
      // so they must NOT be treated as includes (would mis-connect to a
      // same-named Closure.php / Bar.php file).
      expect(isPhpIncludePathRef(mk('Closure'))).toBe(false);
      expect(isPhpIncludePathRef(mk('PDO'))).toBe(false);
      expect(isPhpIncludePathRef(mk('App\\Foo\\Bar'))).toBe(false);
      // scoped to PHP imports only
      expect(isPhpIncludePathRef(mk('lib.php', { language: 'c' }))).toBe(false);
      expect(isPhpIncludePathRef(mk('lib.php', { referenceKind: 'calls' }))).toBe(false);
    });

    it('resolves require_once to a file→file imports edge (#660)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-php-e2e-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'src', 'lib.php'),
          `<?php\nfunction greet() { return "hi"; }\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'src', 'page.php'),
          `<?php\nrequire_once("lib.php");\necho greet();\n`
        );

        scope.cg = await CodeGraph.init(tempProject, { index: true });

        // reporter's repro: page.php's `require_once("lib.php")` must resolve
        // to the real src/lib.php file node — a file→file `imports` edge, so
        // callers(lib.php) now includes page.php.
        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'src/page.php'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        const resolved = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath === 'src/lib.php'
        );
        expect(resolved, 'page.php → src/lib.php imports edge missing').toBeDefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });

    it('resolves a subdirectory include path to the correct file (#660)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-php-subdir-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'inc'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'inc', 'db.php'),
          `<?php\nfunction query() { return 1; }\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'index.php'),
          `<?php\nrequire "inc/db.php";\nquery();\n`
        );

        scope.cg = await CodeGraph.init(tempProject, { index: true });

        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'index.php'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        expect(
          rows.find((r) => r.dstKind === 'file' && r.dstPath === 'inc/db.php'),
          'index.php → inc/db.php imports edge missing'
        ).toBeDefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });

    it('does not mis-connect an unresolvable include to a same-named file elsewhere (#660)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-php-misresolve-'));
      try {
        // app/page.php's `require "inc/db.php"` resolves relative to app/, where
        // inc/db.php does NOT exist. A same-named lib/inc/db.php exists elsewhere
        // but is unrelated — no edge should be created (a wrong edge is worse
        // than a missing one).
        fs.mkdirSync(path.join(tempProject, 'app'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'lib', 'inc'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'lib', 'inc', 'db.php'),
          `<?php\nfunction unrelated() {}\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'app', 'page.php'),
          `<?php\nrequire "inc/db.php";\n`
        );

        scope.cg = await CodeGraph.init(tempProject, { index: true });

        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'app/page.php'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        expect(
          rows.find((r) => r.dstKind === 'file' && r.dstPath === 'lib/inc/db.php'),
          'app/page.php must NOT mis-connect to unrelated lib/inc/db.php'
        ).toBeUndefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });
  });


  describe('C++ chained-call receiver resolution (#645)', () => {
    async function indexCpp(files: Record<string, string>): Promise<void> {
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(scope.tempDir, name), content);
      }
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
    }

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

    it('resolves singleton chains and auto locals to the right class, never the first-sorted one', async () => {
      // Two classes share writeLog; Logger sorts first so it wins any name-only
      // tie. All three call forms target Metrics.
      await indexCpp({
        'logger.hpp': `#pragma once
#include <string>
class Logger  { public: static Logger&  instance(); void writeLog(const std::string&); };
class Metrics { public: static Metrics& instance(); void writeLog(const std::string&); };
`,
        'impl.cpp': `#include "logger.hpp"
Logger&  Logger::instance()  { static Logger l;  return l; }
Metrics& Metrics::instance() { static Metrics m; return m; }
void Logger::writeLog(const std::string&)  {}
void Metrics::writeLog(const std::string&) {}
`,
        'app.cpp': `#include "logger.hpp"
void a() { Metrics::instance().writeLog("x"); }              // chained singleton
void b() { auto& m = Metrics::instance(); m.writeLog("x"); } // stored in auto
void c() { Metrics& m = Metrics::instance(); m.writeLog("x"); } // explicit type
`,
      });

      expect(callerNamesOf('Metrics::writeLog')).toEqual(['a', 'b', 'c']);
      expect(callerNamesOf('Logger::writeLog')).toEqual([]);
    });

    it('resolves factories, free-function factories, and member chains via the inner call return type', async () => {
      await indexCpp({
        'types.hpp': `#pragma once
#include <memory>
struct Widget { void draw(); };
struct Session { void run(); };
struct View { void render(); };
class WidgetFactory { public: static Widget create(); };
class Manager { public: View view(); };
Session* openSession();
// Decoy that sorts first and has all three methods — must never win.
struct Aaa { void draw(); void run(); void render(); };
`,
        'impl.cpp': `#include "types.hpp"
void Widget::draw() {}
void Session::run() {}
void View::render() {}
void Aaa::draw() {}
void Aaa::run() {}
void Aaa::render() {}
Widget WidgetFactory::create() { return Widget(); }
View Manager::view() { return View(); }
Session* openSession() { return nullptr; }
`,
        'app.cpp': `#include "types.hpp"
void factory()     { WidgetFactory::create().draw(); }   // -> Widget::draw
void freefunc()    { openSession()->run(); }             // -> Session::run
void member()      { Manager mgr; mgr.view().render(); }  // -> View::render
void makeUnique()  { auto w = std::make_unique<Widget>(); w->draw(); } // -> Widget::draw
`,
      });

      expect(callerNamesOf('Widget::draw')).toEqual(['factory', 'makeUnique']);
      expect(callerNamesOf('Session::run')).toEqual(['freefunc']);
      expect(callerNamesOf('View::render')).toEqual(['member']);
      // The first-sorted decoy never captures any of them.
      expect(callerNamesOf('Aaa::draw')).toEqual([]);
      expect(callerNamesOf('Aaa::run')).toEqual([]);
      expect(callerNamesOf('Aaa::render')).toEqual([]);
    });

    it('creates NO edge when the inferred type lacks the method (silent miss, not a wrong edge)', async () => {
      await indexCpp({
        'types.hpp': `#pragma once
struct Widget { void draw(); };
struct Other  { void onlyOther(); };
class WidgetFactory { public: static Widget create(); };
`,
        'impl.cpp': `#include "types.hpp"
void Widget::draw() {}
void Other::onlyOther() {}
Widget WidgetFactory::create() { return Widget(); }
`,
        'app.cpp': `#include "types.hpp"
// Widget has no onlyOther() — must produce NO edge, never a wrong one to Other.
void wrong() { WidgetFactory::create().onlyOther(); }
`,
      });

      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });


  describe('C++ explicit operator-call resolution (#1247)', () => {
    // `a.operator+(b)` produced no calls edge: the operator_name lands in an
    // ERROR node (never a field_expression callee), so the extractor emitted a
    // ref named just `a`. With the ERROR-node recovery it emits `a.operator+`,
    // and matchMethodCall (dot pattern extended to admit operator method parts)
    // resolves it through receiver-type inference. Infix `a + b` / `a[i]` need
    // real type inference and are out of scope here (#1258).
    async function indexCpp(files: Record<string, string>): Promise<void> {
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(scope.tempDir, name), content);
      }
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
    }

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

    it('resolves explicit operator calls to the receiver type, never a same-named decoy', async () => {
      // Aaa sorts first and declares the same operators — only receiver-type
      // inference (const V& a → V) can pick V, so a name-only tie can't win.
      await indexCpp({
        'optest.cpp': `struct Aaa {
  Aaa operator+(const Aaa& o) const { return o; }
  Aaa operator[](int i) const { return *this; }
};
struct V {
  int x;
  V operator+(const V& o) const { return V{x + o.x}; }
  V operator[](int i) const { return V{x + i}; }
  int get() const { return x; }
};
int plainCaller(const V& a) { return a.get(); }
V explicitCaller(const V& a, const V& b) { return a.operator+(b); }
V subscriptCaller(const V& a) { return a.operator[](3); }
V pointerCaller(const V* p, const V& b) { return p->operator+(b); }
`,
      });

      expect(callerNamesOf('V::operator+')).toEqual(['explicitCaller', 'pointerCaller']);
      expect(callerNamesOf('V::operator[]')).toEqual(['subscriptCaller']);
      expect(callerNamesOf('V::get')).toEqual(['plainCaller']); // control: plain calls unaffected
      expect(callerNamesOf('Aaa::operator+')).toEqual([]);
      expect(callerNamesOf('Aaa::operator[]')).toEqual([]);
    });

    it('resolves an out-of-line operator definition (declaration in header)', async () => {
      await indexCpp({
        'v.hpp': `#pragma once
struct V { int x; V operator+(const V& o) const; };
`,
        'v.cpp': `#include "v.hpp"
V V::operator+(const V& o) const { return V{x + o.x}; }
`,
        'app.cpp': `#include "v.hpp"
V add(const V& a, const V& b) { return a.operator+(b); }
`,
      });

      expect(callerNamesOf('V::operator+')).toEqual(['add']);
    });
  });


  describe('PHP chained static-factory call resolution (#608)', () => {
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

    it('resolves Cls::for($x)->method() via the factory\'s `: self` return (#608)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'ApiClient.php'),
        `<?php\nclass ApiClient {\n    public static function for(string $c): self { return new self; }\n    public function createOrder(array $p): array { return []; }\n}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'DispatchOrder.php'),
        `<?php\nclass DispatchOrder {\n    public function handle(): void {\n        ApiClient::for('cred')->createOrder([]);\n    }\n}\n`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // The chained call's edge attaches to the factory result's method.
      expect(callerNamesOf('ApiClient::createOrder')).toContain('handle');
    });

    it('creates NO edge when the factory result lacks the method (#608)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'lib.php'),
        `<?php\nclass ApiClient { public static function for(string $c): self { return new self; } }\nclass Other { public function onlyOther(): void {} }\nclass Caller { public function go(): void { ApiClient::for('x')->onlyOther(); } }\n`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // ApiClient has no onlyOther — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });


  describe('Java chained static-factory call resolution (#645/#608 mechanism)', () => {
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

    it('resolves Foo.getInstance().bar() via the factory return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named bar() — it must never win the chain.
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.java'),
        `class Aaa { void bar() {} }
class Foo {
    static Foo getInstance() { return new Foo(); }
    void bar() {}
}
class Caller {
    void run() { Foo.getInstance().bar(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::bar')).toEqual(['run']);
      expect(callerNamesOf('Aaa::bar')).toEqual([]);
    });

    it('resolves a factory chain that passes arguments — Foo.create(cfg).build()', async () => {
      // The factory call carries an argument; the extractor must normalize the
      // receiver to empty parens (`Foo.create().build`) so the chain still splits.
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.java'),
        `class Config {}
class Foo {
    static Foo create(Config c) { return new Foo(); }
    void build() {}
}
class Caller {
    void run() { Foo.create(new Config()).build(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::build')).toEqual(['run']);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.java'),
        `class Foo {
    static Foo getInstance() { return new Foo(); }
}
class Other { void onlyOther() {} }
class Caller {
    void run() { Foo.getInstance().onlyOther(); }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Foo has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });


  describe('Kotlin chained companion-factory call resolution (#645/#608 mechanism)', () => {
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

    it('resolves Foo.getInstance().bar() via the companion return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named bar() — without the chain fix Kotlin
      // dropped the receiver to a bare `bar` and attached to Aaa (a wrong edge).
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.kt'),
        `class Aaa { fun bar() {} }
class Foo {
    companion object {
        fun getInstance(): Foo = Foo()
    }
    fun bar() {}
}
class Caller {
    fun run() { Foo.getInstance().bar() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::bar')).toEqual(['run']);
      expect(callerNamesOf('Aaa::bar')).toEqual([]);
    });

    it('resolves a companion factory chain that passes arguments — Foo.create(cfg).build()', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.kt'),
        `class Config
class Foo {
    companion object {
        fun create(c: Config): Foo = Foo()
    }
    fun build() {}
}
class Caller {
    fun run() { Foo.create(Config()).build() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      expect(callerNamesOf('Foo::build')).toEqual(['run']);
    });

    it('creates NO edge when the companion return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'Main.kt'),
        `class Foo {
    companion object {
        fun getInstance(): Foo = Foo()
    }
}
class Other { fun onlyOther() {} }
class Caller {
    fun run() { Foo.getInstance().onlyOther() }
}
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      // Foo has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

}
