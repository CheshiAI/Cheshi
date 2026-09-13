import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerPythonImportDependencyLinkingBlastRadiusRecallTests(): void {


  describe('Python import dependency linking (blast-radius recall)', () => {
    // Same recall gap as TS: Python only linked called/instantiated imports, so a
    // name brought in with `from module import X` and then merely stored, used as
    // a decorator/argument, or re-exported through an `__init__.py` produced no
    // cross-file edge — the providing module showed a false "0 dependents".
    it('emits an imports reference per name in a `from module import ...` (incl. value/aliased)', () => {
      const code = [
        'from foo import helper, widget',
        'from foo import Thing as T',
        'from . import sibling',
        'from bar import *',
      ].join('\n');
      const names = extractFromSource('mod.py', code)
        .unresolvedReferences.filter((r) => r.referenceKind === 'imports')
        .map((r) => r.referenceName);
      expect(names).toContain('helper');
      expect(names).toContain('widget');   // value import
      expect(names).toContain('T');        // aliased import → local name
      expect(names).toContain('sibling');  // `from . import <name>`
      expect(names).not.toContain('*');    // wildcard import has no names
    });

    it('a Python value imported but never called still makes the importer a dependent', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pkg', 'foo.py'), `widget = {"n": 1}\ndef helper():\n    return 1\n`);
        // bar imports widget+helper but only stores widget in a list — nothing is
        // called, so before import-linking bar had no edge to foo.
        fs.writeFileSync(path.join(dir, 'pkg', 'bar.py'), `from foo import widget, helper\nregistry = [widget]\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('pkg/foo.py')).toContain('pkg/bar.py');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('resolves `from . import submodule` + `submodule.func()` to the submodule', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
        fs.writeFileSync(path.join(dir, 'pkg', 'certs.py'), `def where():\n    return "/ca.pem"\n`);
        // certs is an imported MODULE (a file), and certs.where() is a qualified
        // call through it — the receiver isn't a symbol, so plain name-matching
        // can't link it. Also exercises the Python relative-dot path fix (`.certs`).
        fs.writeFileSync(path.join(dir, 'pkg', 'utils.py'), `from . import certs\ndef go():\n    return certs.where()\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('pkg/certs.py')).toContain('pkg/utils.py');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('a module import is a dependency even when the used member is re-exported elsewhere', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
        // `where` is NOT defined in certs.py (re-exported from a 3rd-party pkg), so
        // member resolution can't find it — the module-import backstop must still
        // record utils -> certs. (Mirrors requests' real `certs.where`.)
        fs.writeFileSync(path.join(dir, 'pkg', 'certs.py'), `from external_ca import where\n`);
        fs.writeFileSync(path.join(dir, 'pkg', 'utils.py'), `from . import certs\nCA = certs.where()\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('pkg/certs.py')).toContain('pkg/utils.py');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });
  });
}
