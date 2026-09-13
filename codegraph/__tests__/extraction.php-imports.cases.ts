import { describe, expect, it } from 'bun:test';
import { extractFromSource } from '../src/extraction';
import { detectLanguage } from '../src/extraction/grammars';
import { blankCppExportMacros } from '../src/extraction/languages/c-cpp';

export function registerPhpImportsTests(): void {


  describe('PHP imports', () => {
    it('should extract simple use', () => {
      const code = `<?php use PHPUnit\\Framework\\TestCase;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('PHPUnit\\Framework\\TestCase');
    });

    it('should extract aliased use', () => {
      const code = `<?php use Mockery as m;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Mockery');
      expect(importNode?.signature).toContain('as m');
    });

    it('should extract function use', () => {
      const code = `<?php use function Illuminate\\Support\\env;`;
      const result = extractFromSource('helpers.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Illuminate\\Support\\env');
      expect(importNode?.signature).toContain('function');
    });

    it('should extract grouped use', () => {
      const code = `<?php use Illuminate\\Database\\{Model, Builder};`;
      const result = extractFromSource('Models.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Database\\Model');
      expect(names).toContain('Illuminate\\Database\\Builder');
    });

    it('should extract multiple uses', () => {
      const code = `<?php
use Illuminate\\Support\\Collection;
use Illuminate\\Support\\Str;
use Closure;
`;
      const result = extractFromSource('Service.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Support\\Collection');
      expect(names).toContain('Illuminate\\Support\\Str');
      expect(names).toContain('Closure');
    });

    it('should extract include/require (+_once) static paths as imports (#660)', () => {
      const code = `<?php
require_once("lib.php");
include 'other.php';
require 'r.php';
include_once("io.php");
`;
      const result = extractFromSource('page.php', code);
      const names = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(names).toContain('lib.php');
      expect(names).toContain('other.php');
      expect(names).toContain('r.php');
      expect(names).toContain('io.php');
    });

    it('should skip dynamic include/require with no static path (#660)', () => {
      const code = `<?php
require_once(__DIR__ . '/dyn.php');
include $file;
include "tpl/{$name}.php";
`;
      const result = extractFromSource('page.php', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports).toHaveLength(0);
    });

    it('should extract include alongside namespace use without interference (#660)', () => {
      const code = `<?php
use App\\Service\\Mailer;
require_once("bootstrap.php");
`;
      const result = extractFromSource('page.php', code);
      const names = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(names).toContain('App\\Service\\Mailer');
      expect(names).toContain('bootstrap.php');
    });
  });


  describe('Ruby imports', () => {
    it('should extract require', () => {
      const code = `require 'json'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
      expect(importNode?.signature).toBe("require 'json'");
    });

    it('should extract require with path', () => {
      const code = `require 'active_support/core_ext/string'`;
      const result = extractFromSource('config.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('active_support/core_ext/string');
    });

    it('should extract require_relative', () => {
      const code = `require_relative '../test_helper'`;
      const result = extractFromSource('test/my_test.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../test_helper');
      expect(importNode?.signature).toContain('require_relative');
    });

    it('should not extract non-require calls', () => {
      const code = `puts 'hello'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeUndefined();
    });

    it('should extract multiple requires', () => {
      const code = `
require 'json'
require 'yaml'
require_relative 'helper'
`;
      const result = extractFromSource('lib.rb', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('json');
      expect(names).toContain('yaml');
      expect(names).toContain('helper');
    });
  });


  describe('Ruby modules', () => {
    it('should extract module as module node with containment', () => {
      const code = `
module CachedCounting
  def self.disable
    @enabled = false
  end

  def perform_increment!(key, count)
    write_cache!(key, count)
  end
end
`;
      const result = extractFromSource('concerns/cached_counting.rb', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module' && n.name === 'CachedCounting');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.qualifiedName).toBe('CachedCounting');

      // Methods inside module should have module-qualified names
      const disableMethod = result.nodes.find((n) => n.name === 'disable' && n.kind === 'method');
      expect(disableMethod).toBeDefined();
      expect(disableMethod?.qualifiedName).toBe('CachedCounting::disable');

      const incrementMethod = result.nodes.find((n) => n.name === 'perform_increment!' && n.kind === 'method');
      expect(incrementMethod).toBeDefined();
      expect(incrementMethod?.qualifiedName).toBe('CachedCounting::perform_increment!');

      // Containment edge from module to methods
      const containsEdges = result.edges.filter((e) => e.source === moduleNode?.id && e.kind === 'contains');
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle nested modules with classes', () => {
      const code = `
module Discourse
  module Auth
    class AuthProvider
      def authenticate(params)
        validate(params)
      end
    end
  end
end
`;
      const result = extractFromSource('lib/auth.rb', code);

      const discourseModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Discourse');
      expect(discourseModule).toBeDefined();

      const authModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Auth');
      expect(authModule).toBeDefined();
      expect(authModule?.qualifiedName).toBe('Discourse::Auth');

      const authProvider = result.nodes.find((n) => n.kind === 'class' && n.name === 'AuthProvider');
      expect(authProvider).toBeDefined();
      expect(authProvider?.qualifiedName).toBe('Discourse::Auth::AuthProvider');

      const authMethod = result.nodes.find((n) => n.name === 'authenticate');
      expect(authMethod).toBeDefined();
      expect(authMethod?.qualifiedName).toBe('Discourse::Auth::AuthProvider::authenticate');
    });
  });


  describe('PHP return type capture (#608)', () => {
    it('captures self/static factory returns as the `self` marker; primitives as undefined', () => {
      const code = `<?php
class ApiClient {
    public static function for(string $c): self { return new self; }
    public static function make(): static { return new static; }
    public function send(array $p): array { return []; }
}`;
      const result = extractFromSource('ApiClient.php', code);
      expect(result.nodes.find((n) => n.name === 'for' && n.kind === 'method')?.returnType).toBe('self');
      expect(result.nodes.find((n) => n.name === 'make' && n.kind === 'method')?.returnType).toBe('self');
      // `array` is not a class to chain on → no return type recorded.
      expect(result.nodes.find((n) => n.name === 'send' && n.kind === 'method')?.returnType).toBeUndefined();
    });

    it('captures a concrete return type as its short class name', () => {
      const code = `<?php
namespace App;
class WidgetFactory { public static function make(): Widget { return new Widget(); } }`;
      const result = extractFromSource('WidgetFactory.php', code);
      expect(result.nodes.find((n) => n.name === 'make' && n.kind === 'method')?.returnType).toBe('Widget');
    });
  });


  describe('C/C++ return type capture (#645)', () => {
    it('captures the normalized return type of a C++ method/function', () => {
      const code = `
struct Widget { void draw(); };
class Factory { public: static Widget create(); };
Widget Factory::create() { return Widget(); }
void doNothing() {}
`;
      const result = extractFromSource('f.cpp', code);

      const create = result.nodes.find(
        (n) => n.name === 'create' && (n.kind === 'method' || n.kind === 'function')
      );
      expect(create?.returnType).toBe('Widget');

      // A `void` return records no type, so resolution never tries to resolve a
      // method on it.
      const doNothing = result.nodes.find((n) => n.name === 'doNothing');
      expect(doNothing).toBeDefined();
      expect(doNothing?.returnType).toBeUndefined();
    });

    it('unwraps a smart-pointer return type to its pointee', () => {
      const code = `
#include <memory>
struct Widget {};
std::unique_ptr<Widget> makeWidget() { return nullptr; }
`;
      const result = extractFromSource('f.cpp', code);

      const make = result.nodes.find((n) => n.name === 'makeWidget');
      expect(make?.returnType).toBe('Widget');
    });
  });


  describe('C++ macro-prefixed class/struct misparse (#946 → recovered in #1061)', () => {
    // An export/visibility macro before the class name (`class MACRO Name :
    // public Base { … }`) makes tree-sitter read `class MACRO` as an elaborated
    // type and the whole declaration as a function_definition named after the
    // class — a phantom `function` that polluted callers/impact/blast-radius.
    // #946 dropped that phantom; #1061's preParse (`blankCppExportMacros`) now
    // blanks the ALL-CAPS macro before parsing, so the class parses normally and
    // is *recovered* — node, members, and base edge all present — not just
    // de-phantomed. The #946 drop survives as the fallback for any residual
    // misparse the blanking doesn't catch.
    it('recovers a macro-annotated class that inherits (no phantom, real class + base edge)', () => {
      const code = `#pragma once
#define MAPCORE_EXPORT __attribute__((visibility("default")))

class DataProvider {
public:
    virtual bool Request(void* param) = 0;
};

class MAPCORE_EXPORT LocalDataProvider : public DataProvider
{
public:
    LocalDataProvider(int dataType);
    virtual bool Request(void* param) override;
};
`;
      // A header rich in C++ (class / public: / virtual) detects as C++ — the
      // issue's exact scenario (a `.h` file). Guard it so a detection regression
      // can't make this test pass for the wrong reason.
      expect(detectLanguage('provider.h', code)).toBe('cpp');
      const result = extractFromSource('provider.h', code);

      // The misparse used to surface as `function | LocalDataProvider` spanning
      // the whole class body — a false caller in the graph. It's gone.
      expect(
        result.nodes.find((n) => n.name === 'LocalDataProvider' && n.kind === 'function')
      ).toBeUndefined();

      // …and the class is now recovered (was dropped under #946), with its
      // `extends DataProvider` edge — the whole point of #1061.
      expect(result.nodes.find((n) => n.name === 'LocalDataProvider')?.kind).toBe('class');
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'DataProvider'
        )
      ).toBeTruthy();

      // The sibling class without the macro is unaffected — still a class.
      expect(result.nodes.find((n) => n.name === 'DataProvider')?.kind).toBe('class');
    });

    it('recovers the struct variant too, without disturbing a genuine class', () => {
      const code = `
#define API __declspec(dllexport)
struct API Widget : public Base { int x; };
class Plain : public Base { public: int y; };
`;
      const result = extractFromSource('widget.cpp', code);

      // `struct MACRO Name : Base { … }` misparses the same way — no phantom
      // function, and the struct is recovered with its base edge.
      expect(
        result.nodes.find((n) => n.name === 'Widget' && n.kind === 'function')
      ).toBeUndefined();
      expect(result.nodes.find((n) => n.name === 'Widget')?.kind).toBe('struct');

      // A normal class with a base clause and no macro is untouched.
      expect(result.nodes.find((n) => n.name === 'Plain')?.kind).toBe('class');
      const exts = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'extends')
        .map((r) => r.referenceName);
      expect(exts.filter((n) => n === 'Base').length).toBe(2); // Widget + Plain both extend Base
    });
  });


  describe('C++ export-macro class recovery (#1061)', () => {
    // Unreal-Engine style: `class MYGAME_API UMyComponent : public UActorComponent`.
    // The leading `*_API` macro alone (base clause or not) triggers the #946
    // misparse and dropped the class — breaking subclass / type-hierarchy /
    // inheritance-impact queries for effectively every gameplay class in a UE
    // project. blankCppExportMacros recovers them.
    it('recovers UE *_API classes and the inheritance edge (the issue repro)', () => {
      const code = `class ENGINE_API UActorComponent { };
class MYGAME_API UMyComponent : public UActorComponent { };
`;
      const result = extractFromSource('ue.cpp', code);
      const classes = result.nodes.filter((n) => n.kind === 'class').map((n) => n.name);
      expect(classes).toContain('UActorComponent'); // macro, no base — also was dropped
      expect(classes).toContain('UMyComponent');
      expect(result.nodes.find((n) => n.kind === 'function')).toBeUndefined(); // no phantom
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'UActorComponent'
        )
      ).toBeTruthy();
    });

    it('blankCppExportMacros blanks only the header macro, offset-preserving', () => {
      // Blanking replaces the macro with equal-length spaces, so the output is
      // byte-for-byte the same length and identical *except* the macro is gone —
      // every downstream line/column stays exact.
      const check = (inp: string, macro: string, rest: string) => {
        const out = blankCppExportMacros(inp);
        expect(out.length).toBe(inp.length); // every byte offset preserved
        expect(out).not.toContain(macro); // the macro token is blanked
        expect(out.replace(/ +/g, ' ')).toBe(rest); // nothing else changed
      };
      // Generalizes across the export-macro space: UE _API, Qt/Boost _EXPORT,
      // LLVM _ABI, bare API.
      check(
        'class MYGAME_API UMyComponent : public UActorComponent { };',
        'MYGAME_API',
        'class UMyComponent : public UActorComponent { };'
      );
      check('struct MAPCORE_EXPORT W : B {}', 'MAPCORE_EXPORT', 'struct W : B {}');
      check('class LLVM_ABI Foo {}', 'LLVM_ABI', 'class Foo {}');
    });

    it('does NOT blank an all-caps class NAME or an elaborated-type var decl', () => {
      // The name itself being ALL-CAPS (with or without a base) must survive —
      // the macro is only the token *before* the name, gated on a `: { ` def.
      for (const c of [
        'class FOO { int x; };',
        'class FOO : public Base { int x; };',
        'struct BAR : public Base { int y; };',
        'enum class COLOR { Red, Green };',
        // elaborated-type variable declarations end in ; = [ — never : {
        'struct FOO bar;',
        'class FOO obj = make();',
        'struct FOO arr[10];',
        // a *_API macro used as an ordinary value elsewhere
        'int x = SOME_API; void f() { use(MYMODULE_API); }',
      ]) {
        expect(blankCppExportMacros(c)).toBe(c);
      }
      // And the all-caps-named class keeps its base edge through real extraction.
      const result = extractFromSource('ctrl.cpp', 'class FOO : public Base { int x; };');
      expect(result.nodes.find((n) => n.name === 'FOO')?.kind).toBe('class');
      expect(
        result.unresolvedReferences.find(
          (r) => r.referenceKind === 'extends' && r.referenceName === 'Base'
        )
      ).toBeTruthy();
    });
  });

}
