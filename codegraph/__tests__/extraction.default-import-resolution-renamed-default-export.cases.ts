import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerDefaultImportResolutionRenamedDefaultExportTests(): void {


  describe('Default import resolution (renamed default export)', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a renamed default import to the module file', async () => {
      // Express route aggregator: `import articlesController from './controller'`
      // where the module does `export default router`. The renamed local can't be
      // found as a symbol, so the controller file had no dependent — the dependency
      // is on the module file regardless of the default export's name.
      fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'app/controller.ts'), `const router = { get() {} };\nexport default router;\n`);
      fs.writeFileSync(path.join(tempDir, 'app/routes.ts'), `import myController from './controller';\nexport const api = myController;\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const controller = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('app/controller.ts'));
      expect(controller, 'controller.ts indexed').toBeDefined();
      const deps = [...cg.getImpactRadius(controller!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('routes.ts')), 'importer depends on the default-exporting module').toBe(true);
    });
  });
}
