import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerCrossLanguageTypeImportGateRnNameCollisionsTests(): void {


  describe('Cross-language type/import gate (RN name collisions)', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('a TS PascalCase type ref lands on the TS type, never a same-named native class', async () => {
      // react-native-async-storage's example app has a TS `type TestRunner` AND a
      // Kotlin `class TestRunner`. The React PascalCase resolver name-matched the
      // Kotlin `class` (its COMPONENT_KINDS includes `class`) with no language
      // check at confidence 0.8, outranking the (cross-language-penalized 0.5)
      // TS name-match — so a TS ref to `TestRunner` crossed web→jvm. The ref here
      // is intentionally NOT imported: a clean relative import would mask the bug
      // by resolving via the import map before the framework strategy can win.
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ dependencies: { 'react-native': '*' } })
      );
      fs.writeFileSync(
        path.join(tempDir, 'useTests.ts'),
        `export type TestRunner = { run: () => void };\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'basic.tsx'),
        `export function useBasicTest(r: TestRunner): TestRunner {\n  return r;\n}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'TestUtils.kt'),
        `package app\nclass TestRunner {\n  fun run() {}\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const ktRunner = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'TestRunner' && n.filePath.endsWith('TestUtils.kt'));
      expect(ktRunner, 'Kotlin TestRunner class').toBeDefined();
      const ktDeps = [...cg.getImpactRadius(ktRunner!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(ktDeps.some((p) => p.endsWith('basic.tsx')), 'Kotlin class has NO TS dependent').toBe(false);

      const tsRunner = cg.getNodesByKind('type_alias').find((n) => n.name === 'TestRunner');
      expect(tsRunner, 'TS TestRunner type_alias').toBeDefined();
      const tsDeps = [...cg.getImpactRadius(tsRunner!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(tsDeps.some((p) => p.endsWith('basic.tsx')), 'TS type captured the ref (re-pointed)').toBe(true);
    });

    it('gates a cross-family import name collision but keeps same-family imports', async () => {
      // A TS `import { Widget }` that only matches a Swift `class Widget` must not
      // create a web→apple dependency — but a sibling TS module imported by
      // another TS file (same family) must still resolve (no over-gating).
      fs.writeFileSync(path.join(tempDir, 'Widget.swift'), `class Widget {\n  func render() {}\n}\n`);
      fs.writeFileSync(
        path.join(tempDir, 'widget.ts'),
        `import { Widget } from './native';\nexport function mount(w: Widget) {}\n`
      );
      fs.writeFileSync(path.join(tempDir, 'util.ts'), `export class Helper {}\n`);
      fs.writeFileSync(
        path.join(tempDir, 'app.ts'),
        `import { Helper } from './util';\nexport const h = new Helper();\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const swiftWidget = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'Widget' && n.filePath.endsWith('.swift'));
      expect(swiftWidget, 'Swift Widget class').toBeDefined();
      const wDeps = [...cg.getImpactRadius(swiftWidget!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(wDeps.some((p) => p.endsWith('widget.ts')), 'Swift class has NO TS dependent').toBe(false);

      // Same-family control — the TS Helper must still see its TS dependent.
      const helper = cg.getNodesByKind('class').find((n) => n.name === 'Helper');
      expect(helper, 'TS Helper class').toBeDefined();
      const hDeps = [...cg.getImpactRadius(helper!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(hDeps.some((p) => p.endsWith('app.ts')), 'same-family TS import preserved').toBe(true);
    });
  });
}
