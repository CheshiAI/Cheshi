import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection } from '../src';
import { ResolutionContext } from '../src/resolution';
import { clearCppIncludeDirCache, extractImportMappings, loadCppIncludeDirs, resolveImportPath } from '../src/resolution/import-resolver';

export function registerCNamespaceQualifiedStaticMethodCallsToOutOfLineDefinitions1Tests(scope: {
  cg: CodeGraph;
  tempDir: string;
}): void {


  describe('C++ namespace-qualified static method calls to out-of-line definitions (#1291)', () => {
    // The issue's exact shape: nested types + out-of-line static method
    // definition inside `namespace simulator { }` in the .cpp, called via the
    // fully-qualified path from a different file. The definition's
    // qualifiedName previously dropped the namespace (`ManifestStartup::Apply`
    // vs the class's `simulator::ManifestStartup`), so `callers` came up empty.
    it('resolves simulator::ManifestStartup::Apply(...) from another file', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1291-'));
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'manifest_startup.h'),
          `#pragma once
namespace simulator {
class ManifestStartup {
public:
    struct Input { int a; };
    struct Output { int b; };
    static Output Apply(const Input& input);
};
}
`
        );
        fs.writeFileSync(
          path.join(tmpDir, 'manifest_startup.cpp'),
          `#include "manifest_startup.h"
namespace simulator {
ManifestStartup::Output ManifestStartup::Apply(const Input& input) {
    return Output{input.a};
}
}
`
        );
        fs.writeFileSync(
          path.join(tmpDir, 'main.cpp'),
          `#include "manifest_startup.h"
int run() {
    const auto manifest_result = simulator::ManifestStartup::Apply({1});
    return manifest_result.b;
}
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const applyDefs = cg.searchNodes('Apply', { limit: 20 }).filter(
          (r) => r.node.name === 'Apply' && r.node.kind === 'method'
        );
        expect(applyDefs.length).toBeGreaterThan(0);
        const def = applyDefs.find((r) => r.node.filePath.endsWith('manifest_startup.cpp'));
        expect(def).toBeDefined();
        expect(def!.node.qualifiedName).toBe('simulator::ManifestStartup::Apply');

        // The qualified cross-file call resolves: run() is a caller of Apply.
        const callers = cg.getCallers(def!.node.id);
        expect(callers.map((c) => c.node.name)).toContain('run');
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);
  });


  describe('C/C++ Import Resolution', () => {
    afterEach(() => {
      clearCppIncludeDirCache();
    });

    it('should resolve C include to header in same directory', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'utils.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['utils.h', 'main.c'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        'utils.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('utils.h');
    });

    it('should resolve C++ include with .hpp extension', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'include/myclass.hpp',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myclass.hpp', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        'myclass.hpp',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myclass.hpp');
    });

    it('should resolve include with subdirectory path', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'utils/helpers.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['utils/helpers.h', 'main.c'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        'utils/helpers.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('utils/helpers.h');
    });

    it('should resolve include via include directories', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'include/myheader.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myheader.h', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        'myheader.h',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myheader.h');
    });

    it('should resolve include trying multiple extensions', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        // myclass.h does not exist, but myclass.hpp does
        fileExists: (p) => p === 'include/myclass.hpp',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myclass.hpp', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        'myclass',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myclass.hpp');
    });

    it('should return null for system headers', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // C standard library header
      expect(resolveImportPath('stdio.h', 'main.c', 'c', context)).toBeNull();
      // C++ standard library header
      expect(resolveImportPath('vector', 'main.cpp', 'cpp', context)).toBeNull();
      // C++ C-wrapper header
      expect(resolveImportPath('cstdio', 'main.cpp', 'cpp', context)).toBeNull();
    });

    it('should return null for single-component third-party paths that cannot be resolved', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getCppIncludeDirs: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Third-party bare header without path — not resolvable, returns null
      const result = resolveImportPath(
        'openssl/ssl.h',
        'main.cpp',
        'cpp',
        context
      );

      expect(result).toBeNull();
    });

    it('should not filter project headers with path separators', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'mylib/utils.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['mylib/utils.h'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Path with separator should NOT be filtered as external
      const result = resolveImportPath(
        'mylib/utils.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('mylib/utils.h');
    });

    it('should extract C/C++ import mappings from #include directives', () => {
      const code = `#include <iostream>
#include "myheader.h"
#include "utils/helpers.hpp"`;

      const mappings = extractImportMappings('main.cpp', code, 'cpp');

      expect(mappings.length).toBe(3);
      expect(mappings[0]).toEqual({
        localName: 'iostream',
        exportedName: '*',
        source: 'iostream',
        isDefault: false,
        isNamespace: true,
      });
      expect(mappings[1]).toEqual({
        localName: 'myheader',
        exportedName: '*',
        source: 'myheader.h',
        isDefault: false,
        isNamespace: true,
      });
      expect(mappings[2]).toEqual({
        localName: 'helpers',
        exportedName: '*',
        source: 'utils/helpers.hpp',
        isDefault: false,
        isNamespace: true,
      });
    });

    it('should discover include directories from compile_commands.json', () => {
      // Create a temp project with compile_commands.json
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        const compileDb = [
          {
            directory: tempProject,
            command: 'g++ -Iinclude -Isrc/lib -isystem /usr/include -c src/main.cpp',
            file: 'src/main.cpp',
          },
        ];
        fs.writeFileSync(
          path.join(tempProject, 'compile_commands.json'),
          JSON.stringify(compileDb)
        );
        // Create the include dirs so they exist
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'src', 'lib'), { recursive: true });

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        // Should find include and src/lib (relative to project root)
        // /usr/include is absolute and outside project, should be excluded
        expect(dirs).toContain('include');
        expect(dirs).toContain('src/lib');
        expect(dirs.some(d => d.includes('usr'))).toBe(false);
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    it('should fall back to heuristic include dirs when no compile_commands.json', () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        // Create include/ and src/ directories with headers
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'include', 'types.h'), '');
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'src', 'main.cpp'), '');
        // Create a directory without headers — should not be included
        fs.mkdirSync(path.join(tempProject, 'docs'), { recursive: true });

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        expect(dirs).toContain('include');
        expect(dirs).toContain('src');
        expect(dirs).not.toContain('docs');
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    // Documents the cross-language `.h` behavior. Objective-C and C++ share
    // the `.h` extension, so in a mixed iOS-style project an Obj-C header
    // dir gets claimed as a C/C++ include dir too. That's intentional — a
    // C++ file legitimately can `#include "Foo.h"` against an Obj-C header
    // (Obj-C++ / .mm callers), and false-positive inclusion is far cheaper
    // than missing real resolutions. The test pins this so a later
    // "exclude objc dirs" refactor breaks loudly and reviewers see the
    // trade-off explicitly.
    it('heuristic claims any top-level dir containing .h files, including Obj-C', () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        // C++ side: an `cppmod` dir with a .hpp (C++-only extension)
        fs.mkdirSync(path.join(tempProject, 'cppmod'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'cppmod', 'shared.hpp'), '');
        // Obj-C side: an `iosmod` dir with .h + .m (no .cpp/.hpp).
        fs.mkdirSync(path.join(tempProject, 'iosmod'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'iosmod', 'View.h'), '');
        fs.writeFileSync(path.join(tempProject, 'iosmod', 'View.m'), '');

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        // Both included — Obj-C dirs are intentionally allowed.
        expect(dirs).toContain('cppmod');
        expect(dirs).toContain('iosmod');
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    // End-to-end: ensure `#include "X.h"` produces a file→file `imports` edge
    // in the actual indexing pipeline (not just a phantom file→import-node
    // edge). This pins the include-dir resolution path so the headline PR
    // feature can't silently regress to a no-op in the indexing flow.
    it('connects #include to the real header file via include-dir scan (end-to-end)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-e2e-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'include', 'utils.h'),
          `#ifndef UTILS_H\n#define UTILS_H\nint add(int, int);\n#endif\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'src', 'main.cpp'),
          `#include "utils.h"\n#include <vector>\nint main(){ return add(1,2); }\n`
        );

        clearCppIncludeDirCache();
        scope.cg = await CodeGraph.init(tempProject, { index: true });

        // Sanity: file nodes exist for the header and the cpp.
        const allFiles = scope.cg.getStats();
        expect(allFiles.fileCount).toBe(2);

        // The `#include "utils.h"` edge should target the real
        // `include/utils.h` file node — not a floating `import` node
        // living inside main.cpp.
        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'src/main.cpp'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        const resolvedToHeader = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath === 'include/utils.h'
        );
        expect(resolvedToHeader, 'main.cpp → include/utils.h imports edge missing').toBeDefined();
        // `<vector>` should NOT produce a file edge — it's a stdlib header.
        const stdlibFile = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath && r.dstPath.endsWith('vector')
        );
        expect(stdlibFile).toBeUndefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });
  });


  describe('C++ templated base-class inheritance (#1043)', () => {
    // A class deriving from a TEMPLATE — `class D : public Base<int>` (or a CRTP
    // `class W : public CRTPBase<W>`, or a qualified `class Q : public ns::Tpl<int>`)
    // recorded its base as the full instantiation text (`Base<int>`), which never
    // name-matched the template, indexed as the bare node `Base`. The `<…>` args
    // are now stripped so the `extends` edge resolves end-to-end.
    it('resolves an extends edge to a templated base (plain, CRTP, struct, multi-base)', async () => {
      fs.writeFileSync(
        path.join(scope.tempDir, 'lib.hpp'),
        `#pragma once
template<typename T> class Base { public: void foo(); };
template<typename Derived> class CRTPBase {};
class Plain {};

class Widget : public Base<int> {};            // plain template base
class App : public CRTPBase<App> {};           // CRTP (curiously-recurring)
struct Node : public Base<double> {};          // struct inheriting a template
class Both : public Base<char>, public Plain {}; // templated + plain in one clause
`
      );
      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      const db = DatabaseConnection.open(path.join(scope.tempDir, '.codegraph', 'codegraph.db'));
      const edges = db
        .getDb()
        .prepare(
          `select src.name as fromName, dst.name as toName
             from edges e
             join nodes src on e.source = src.id
             join nodes dst on e.target = dst.id
            where e.kind = 'extends'`
        )
        .all() as Array<{ fromName: string; toName: string }>;
      const has = (from: string, to: string) =>
        edges.some((r) => r.fromName === from && r.toName === to);

      // Every templated base now resolves to the bare template node.
      expect(has('Widget', 'Base'), 'Widget : Base<int>').toBe(true);
      expect(has('App', 'CRTPBase'), 'App : CRTPBase<App> (CRTP)').toBe(true);
      expect(has('Node', 'Base'), 'struct Node : Base<double>').toBe(true);
      // A mixed clause resolves BOTH the templated and the plain base.
      expect(has('Both', 'Base'), 'Both : Base<char>').toBe(true);
      expect(has('Both', 'Plain'), 'Both : Plain (non-templated, regression guard)').toBe(true);
    });
  });

}
