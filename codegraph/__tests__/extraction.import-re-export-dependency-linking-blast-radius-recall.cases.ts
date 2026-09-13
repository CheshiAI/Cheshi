import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerImportReExportDependencyLinkingBlastRadiusRecallTests(): void {


  describe('Import / re-export dependency linking (blast-radius recall)', () => {
    // An import IS a dependency, but extraction only emits references for calls,
    // instantiations, type annotations, and inheritance — so a symbol imported and
    // then merely re-exported, placed in a registry array, passed as an argument,
    // or used in JSX produced no cross-file edge, leaving the providing file with a
    // false "0 dependents". These tests pin the import/re-export binding linking.
    it('emits an imports reference per named, aliased, and default import binding', () => {
      const code = `
import { widget, helper as h } from './foo';
import Thing from './thing';
import * as NS from './ns';
export const registry = [widget];
`;
      const result = extractFromSource('bar.ts', code);
      const names = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'imports')
        .map((r) => r.referenceName);
      expect(names).toContain('widget');   // named import → local name
      expect(names).toContain('h');        // aliased import → local alias
      expect(names).toContain('Thing');    // default import
      expect(names).toContain('NS');       // namespace import → linked to the module file as a dependency
    });

    it('emits an imports reference per re-exported binding', () => {
      const result = extractFromSource('barrel.ts', `export { alpha, beta as b } from './source';`);
      const names = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'imports')
        .map((r) => r.referenceName);
      // Re-export links the SOURCE-side name, not the local alias.
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
    });

    it('a value imported/re-exported but never called still makes the importer a dependent', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'src', 'foo.ts'),
          `export const widget = { n: 1 };\nexport function helper(): void {}\n`
        );
        // bar uses widget ONLY in an array and re-exports helper — neither is
        // called/typed, so before import-linking bar had no edge to foo at all.
        fs.writeFileSync(
          path.join(dir, 'src', 'bar.ts'),
          `import { widget } from './foo';\nexport { helper } from './foo';\nexport const registry = [widget];\n`
        );
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('src/foo.ts')).toContain('src/bar.ts');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('a namespace import touched only via a value-member read still links the module file', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), `export const SOME_CONST = 42;\n`);
        // `foo` is imported as a namespace and used ONLY via a value-member read
        // (no call, no type) — `foo.helper()` would link on its own, but a bare
        // `foo.SOME_CONST` would not, so the module-import backstop must link it.
        fs.writeFileSync(path.join(dir, 'src', 'bar.ts'), `import * as foo from './foo';\nexport const x = foo.SOME_CONST;\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('src/foo.ts')).toContain('src/bar.ts');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });
  });
}
