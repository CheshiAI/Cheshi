import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerNuxtNestedAutoImportedComponentResolutionTests(): void {


  describe('Nuxt nested auto-imported component resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a `<MediaCard/>` usage to components/media/Card.vue (Nuxt dir-prefixed auto-import)', async () => {
      // Nuxt auto-imports a nested component by a DIRECTORY-PREFIXED name —
      // components/media/Card.vue is used as <MediaCard/>, not <Card/> — but the
      // component node is named by basename (`Card`), so the PascalCase usage
      // didn't resolve and the nested component looked unused.
      const media = path.join(tempDir, 'components/media');
      fs.mkdirSync(media, { recursive: true });
      fs.writeFileSync(path.join(media, 'Card.vue'), /* language=TEXT */ `<template><div>card</div></template>\n<script setup>defineProps(['item'])</script>\n`);
      fs.writeFileSync(
        path.join(tempDir, 'components/Grid.vue'),
      /* language=TEXT */ `<template>\n  <div><MediaCard :item="i" /></div>\n</template>\n<script setup>const i = {}</script>\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const card = cg.getNodesByKind('component').find((n) => n.filePath.endsWith('media/Card.vue'));
      expect(card, 'media/Card.vue component').toBeDefined();
      const deps = [...cg.getImpactRadius(card!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('components/Grid.vue')), '<MediaCard> links Grid to media/Card.vue').toBe(true);
    });
  });
}
