import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerSwiftPropertyWrapperAttributeTypeReferencesTests(): void {


  describe('Swift property-wrapper attribute type references', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('a Fluent `@Siblings(through: Pivot.self)` links the model to the pivot type', async () => {
      // A many-to-many pivot/join model is referenced ONLY through the relationship
      // property wrapper's metatype argument (`Pivot.self`), never by a controller
      // query. The wrapper type was captured but the argument expression wasn't
      // walked, so the pivot model looked like nothing depended on it.
      fs.writeFileSync(path.join(tempDir, 'Pivot.swift'),
        `import Fluent\nfinal class AcronymCategoryPivot: Model {\n  static let schema = "acronym-category"\n}\n`);
      fs.writeFileSync(path.join(tempDir, 'Acronym.swift'),
        `import Fluent\nfinal class Acronym: Model {\n` +
        `  @Siblings(through: AcronymCategoryPivot.self, from: \\.$acronym, to: \\.$category)\n` +
        `  var categories: [Category]\n}\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const pivot = cg.getNodesByKind('class').find((n) => n.name === 'AcronymCategoryPivot');
      expect(pivot, 'pivot model class').toBeDefined();
      const deps = [...cg.getImpactRadius(pivot!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('Acronym.swift')), '@Siblings metatype arg links Acronym to the pivot').toBe(true);
    });
  });
}
