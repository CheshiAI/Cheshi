import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerLiquidShopifyJsonTemplateSectionResolutionTests(): void {


  describe('Liquid Shopify JSON template section resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a Shopify JSON template section `type` to its sections/<type>.liquid', async () => {
      // Shopify OS 2.0 templates are JSON, referencing sections by `type` — not
      // a `{% section %}` Liquid tag — so a section used only from a JSON template
      // looked unused. The JSON is now indexed and its `type`s linked.
      fs.mkdirSync(path.join(tempDir, 'sections'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'templates/customers'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'sections/main-product.liquid'), `<div>{{ product.title }}</div>\n`);
      fs.writeFileSync(path.join(tempDir, 'sections/main-login.liquid'), `<form>{{ 'customer.login' | t }}</form>\n`);
      fs.writeFileSync(path.join(tempDir, 'templates/product.json'), JSON.stringify({ sections: { main: { type: 'main-product' } }, order: ['main'] }));
      // Nested template dir (templates/customers/login.json) must resolve too.
      fs.writeFileSync(path.join(tempDir, 'templates/customers/login.json'), JSON.stringify({ sections: { main: { type: 'main-login' } }, order: ['main'] }));

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const product = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('sections/main-product.liquid'));
      const login = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('sections/main-login.liquid'));
      expect(product, 'main-product section').toBeDefined();
      expect(login, 'main-login section').toBeDefined();
      expect(cg.getFileDependents(product!.filePath).some((p) => p.endsWith('templates/product.json')), 'top-level JSON template links its section').toBe(true);
      expect(cg.getFileDependents(login!.filePath).some((p) => p.endsWith('customers/login.json')), 'nested JSON template links its section').toBe(true);
    });
  });
}
