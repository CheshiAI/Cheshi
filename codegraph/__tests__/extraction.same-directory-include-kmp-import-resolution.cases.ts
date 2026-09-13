import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerSameDirectoryIncludeKmpImportResolutionTests(): void {


  describe('Same-directory include + KMP import resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('a C/C++ #include resolves to the same-directory header, not a same-named one elsewhere', async () => {
      // A multi-platform native module has a header of the same basename per
      // platform. `windows/Provider.cpp`'s `#include "Storage.h"` means its OWN
      // sibling header — not `apple/Storage.h` (which sorts first and so was
      // picked arbitrarily before, leaving the real local header with 0 deps).
      fs.mkdirSync(path.join(tempDir, 'apple'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'windows'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'apple', 'Storage.h'), `#pragma once\nstruct Storage { int n; };\n`);
      fs.writeFileSync(path.join(tempDir, 'windows', 'Storage.h'), `#pragma once\nstruct Storage { int n; };\n`);
      fs.writeFileSync(
        path.join(tempDir, 'windows', 'Provider.cpp'),
        `#include "Storage.h"\nint use() { Storage s; return s.n; }\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const winHeader = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('windows/Storage.h'));
      const appleHeader = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('apple/Storage.h'));
      expect(winHeader, 'windows/Storage.h indexed').toBeDefined();
      expect(appleHeader, 'apple/Storage.h indexed').toBeDefined();
      const winDeps = [...cg.getImpactRadius(winHeader!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      const appleDeps = [...cg.getImpactRadius(appleHeader!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(winDeps.some((p) => p.endsWith('Provider.cpp')), 'same-dir header gets the includer').toBe(true);
      expect(appleDeps.some((p) => p.endsWith('Provider.cpp')), 'other-platform header does NOT').toBe(false);
    });

    it('a Kotlin Multiplatform commonMain import resolves to the expect, not a platform actual', async () => {
      const common = path.join(tempDir, 'src/commonMain/kotlin/app');
      const android = path.join(tempDir, 'src/androidMain/kotlin/app');
      fs.mkdirSync(common, { recursive: true });
      fs.mkdirSync(android, { recursive: true });
      fs.writeFileSync(path.join(common, 'Platform.kt'), `package app\nexpect class PlatformContext\n`);
      fs.writeFileSync(path.join(android, 'Platform.android.kt'), `package app\nactual class PlatformContext\n`);
      fs.writeFileSync(
        path.join(common, 'Db.kt'),
        `package app\nimport app.PlatformContext\nclass Db {\n  fun open(ctx: PlatformContext) {}\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const expectCtx = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'PlatformContext' && n.filePath.endsWith('commonMain/kotlin/app/Platform.kt'));
      expect(expectCtx, 'commonMain expect PlatformContext').toBeDefined();
      const deps = [...cg.getImpactRadius(expectCtx!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('Db.kt')), 'commonMain import lands on the expect, not the actual').toBe(true);
    });
  });
}
