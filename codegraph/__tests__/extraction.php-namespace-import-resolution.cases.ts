import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerPhpNamespaceImportResolutionTests(): void {


  describe('PHP namespace + import resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('resolves `use` imports to the namespace-qualified definition and type-hints across files', async () => {
      const src = path.join(tempDir, 'src');
      // Two interfaces with the SAME simple name in different namespaces — the
      // exact ambiguity (Laravel has 7+ `Factory`) that bare-name matching can't
      // resolve. The namespace qualifies them; the `use` import disambiguates.
      fs.mkdirSync(path.join(src, 'Cache'), { recursive: true });
      fs.mkdirSync(path.join(src, 'Mail'), { recursive: true });
      fs.mkdirSync(path.join(src, 'App'), { recursive: true });
      fs.writeFileSync(
        path.join(src, 'Cache', 'Factory.php'),
        `<?php
namespace Contracts\\Cache;

interface Factory {
    public function store(): object;
}
`
      );
      fs.writeFileSync(
        path.join(src, 'Mail', 'Factory.php'),
        `<?php
namespace Contracts\\Mail;

interface Factory {
    public function mailer(): object;
}
`
      );
      fs.writeFileSync(
        path.join(src, 'App', 'Service.php'),
        `<?php
namespace App;

use Contracts\\Cache\\Factory;

class Service {
    public function make(): Factory {
        return resolve(Factory::class);
    }
}
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // The PHP namespace is captured into the qualified name, so the two
      // same-named interfaces are distinguishable.
      const cacheFactory = cg
        .getNodesByKind('interface')
        .find((n) => n.qualifiedName === 'Contracts\\Cache::Factory');
      const mailFactory = cg
        .getNodesByKind('interface')
        .find((n) => n.qualifiedName === 'Contracts\\Mail::Factory');
      expect(cacheFactory).toBeDefined();
      expect(mailFactory).toBeDefined();

      // Service `use`s Contracts\Cache\Factory, so editing THAT interface reaches
      // Service.php — and editing the same-named Contracts\Mail\Factory must NOT
      // (the import resolved to the right namespace, not an arbitrary `Factory`).
      const serviceFile = 'src/App/Service.php';
      const cacheReaches = [...cg.getImpactRadius(cacheFactory!.id, 3).nodes.values()].some(
        (n) => (n.filePath ?? '').endsWith(serviceFile)
      );
      const mailReaches = [...cg.getImpactRadius(mailFactory!.id, 3).nodes.values()].some(
        (n) => (n.filePath ?? '').endsWith(serviceFile)
      );
      expect(cacheReaches).toBe(true);
      expect(mailReaches).toBe(false);
    });
  });
}
