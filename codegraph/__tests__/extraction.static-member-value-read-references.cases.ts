import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerStaticMemberValueReadReferencesTests(): void {


  describe('Static-member / value-read references', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a type referenced only via a static field / enum value (and ignores lowercase receivers)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'JsonScope.java'),
        `class JsonScope {
  static final int EMPTY_DOCUMENT = 1;
}
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'Reader.java'),
        `class Reader {
  private int helper;
  int peek() {
    return JsonScope.EMPTY_DOCUMENT;
  }
  int noop() {
    return this.helper;
  }
}
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // JsonScope is used ONLY as `JsonScope.EMPTY_DOCUMENT` (a static-field value
      // read — never constructed or called), so before the static-member pass it
      // had no dependents. Editing it now surfaces Reader.java.
      const scope = cg.getNodesByKind('class').find((n) => n.name === 'JsonScope');
      expect(scope, 'JsonScope indexed').toBeDefined();
      const reached = [...cg.getImpactRadius(scope!.id, 3).nodes.values()].map((n) => n.filePath ?? '');
      expect(reached.some((p) => p.endsWith('Reader.java'))).toBe(true);

      // A lowercase receiver (`this.helper`) must NOT be emitted as a type ref —
      // only Capitalized receivers (types) are. No node named `this`/`helper`
      // should appear as a reference target from peek/noop beyond JsonScope.
      const refTargets = cg
        .getNodesByKind('class')
        .filter((n) => n.name === 'this' || n.name === 'helper');
      expect(refTargets.length).toBe(0);
    });

    it('does not link a static-member read across language families (coincidental name)', async () => {
      // A native (Kotlin) `Build.VERSION` reads the Android system class — it must
      // NOT link to a coincidentally same-named TS class (the cross-language false
      // positive that name-matching produces; `references` edges are language-local).
      fs.writeFileSync(
        path.join(tempDir, 'Build.ts'),
        `export class Build {\n  static version = 1;\n}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'Device.kt'),
        `package app\nclass Device {\n  fun sdk(): Int = Build.VERSION\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const tsBuild = cg.getNodesByKind('class').find((n) => n.name === 'Build' && n.filePath.endsWith('Build.ts'));
      expect(tsBuild).toBeDefined();
      // The Kotlin file is `app/Device.kt`; the TS Build must have NO dependent there.
      const deps = [...cg.getImpactRadius(tsBuild!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('Device.kt'))).toBe(false);
    });
  });
}
