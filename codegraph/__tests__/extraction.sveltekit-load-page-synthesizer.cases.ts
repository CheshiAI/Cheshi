import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerSveltekitLoadPageSynthesizerTests(): void {


  describe('SvelteKit load → page synthesizer', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a +page.svelte to its OWN directory\'s +page.server.js load, not another route\'s', async () => {
      // SvelteKit wires +page.server.js's `load` to +page.svelte's `data` BY FILE
      // PATH — there is no static import — so editing a loader showed no impact on
      // the page it feeds. The synthesizer links each page component to the `load`
      // in its OWN directory (path-deterministic, so it never crosses routes).
      const login = path.join(tempDir, 'src/routes/login');
      const register = path.join(tempDir, 'src/routes/register');
      fs.mkdirSync(login, { recursive: true });
      fs.mkdirSync(register, { recursive: true });
      fs.writeFileSync(path.join(login, '+page.svelte'), /* language=TEXT */ `<script>export let data;</script>\n<h1>Login {data.x}</h1>\n`);
      fs.writeFileSync(path.join(login, '+page.server.js'), `export function load() { return { x: 1 }; }\n`);
      fs.writeFileSync(path.join(register, '+page.svelte'), /* language=TEXT */ `<script>export let data;</script>\n<h1>Register</h1>\n`);
      fs.writeFileSync(path.join(register, '+page.server.js'), `export function load() { return { y: 2 }; }\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const loginLoad = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'load' && n.filePath.endsWith('login/+page.server.js'));
      expect(loginLoad, 'login load fn').toBeDefined();
      const impacted = [...cg.getImpactRadius(loginLoad!.id, 3).nodes.values()].map((n) => n.filePath ?? '');
      // editing login's load surfaces login's page (the framework-wired data flow)…
      expect(impacted.some((p) => p.endsWith('login/+page.svelte')), 'load links to its own page').toBe(true);
      // …but never register's page (same-directory only).
      expect(impacted.some((p) => p.endsWith('register/+page.svelte')), 'does not cross routes').toBe(false);
    });
  });
}
