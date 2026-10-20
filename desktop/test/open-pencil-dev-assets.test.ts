import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { buildCachedEditor } from '../../scripts/open-pencil-build-cache.mts';
import { openPencilDevAssets } from '../frontend/open-pencil/dev-assets.ts';

test('an open editor loads history for the first time after multiple rebuilds through Vite', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cheshi-editor-dev-assets-'));
  let server: ViteDevServer | undefined;
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'source.ts'), 'editor');
    let generation = 0;
    const options = {
      root, output: path.join(root, 'public/open-pencil'), inputs: ['source.ts'], toolchain: 'test',
      build: async (directory: string) => {
        const hash = String(++generation).padStart(8, '0');
        await mkdir(path.join(directory, 'assets'));
        await writeFile(path.join(directory, 'index.html'), `<script type="module" src="./assets/index-${hash}.js"></script>`);
        const files = {
          [`index-${hash}.js`]: `export const loadHistory = () => import('./CanvasHistoryPanel-${hash}.js');`,
          [`CanvasHistoryPanel-${hash}.js`]: `import {version} from './shared-${hash}.js'; export {version};`,
          [`shared-${hash}.js`]: `export const version = ${generation};`,
          [`history-${hash}.css`]: `.history { --generation: ${generation}; }`,
        };
        for (const [name, content] of Object.entries(files)) {
          await writeFile(path.join(directory, 'assets', name), content);
        }
      },
    };
    await buildCachedEditor(options);
    // Hold the old entry in memory, but do not import the history panel yet.
    const openEditor = await import(pathToFileURL(path.join(options.output, 'assets/index-00000001.js')).href) as {
      loadHistory(): Promise<{ version: number }>;
    };
    server = await createServer({
      configFile: false, root, logLevel: 'silent',
      plugins: [openPencilDevAssets(path.join(root, 'node_modules/.cache/cheshi-open-pencil/previous/assets'))],
      // A frozen inventory makes the publication race deterministic.
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const getAsset = async (name: string, type: RegExp) => {
      const response = await fetch(`${base}/open-pencil/${name}`);
      const body = await response.text();
      assert.equal(response.status, 200, `${name}: ${body}`);
      assert.match(response.headers.get('content-type') ?? '', type);
      assert.equal(body, await readFile(path.join(options.output, name), 'utf8'));
      return body;
    };
    await getAsset('assets/index-00000001.js', /javascript/u);
    await buildCachedEditor({ ...options, force: true });
    await buildCachedEditor({ ...options, force: true });
    for (const hash of ['00000001', '00000002', '00000003']) {
      await getAsset(`assets/CanvasHistoryPanel-${hash}.js`, /javascript/u);
      await getAsset(`assets/shared-${hash}.js`, /javascript/u);
      await getAsset(`assets/history-${hash}.css`, /css/u);
    }
    assert.equal((await openEditor.loadHistory()).version, 1);
    assert.equal((await buildCachedEditor(options)).reused, true);
    const head = await fetch(`${base}/open-pencil/assets/CanvasHistoryPanel-00000001.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 0);
    const secret = path.join(root, 'outside.js');
    await writeFile(secret, 'must not be served');
    await createSymbolicLink(secret, path.join(options.output, 'assets/outside-link.js'));
    for (const name of ['outside-link.js', '%2e%2e%2foutside.js', '%2e%2e%5coutside.js', 'missing.js']) {
      const response = await fetch(`${base}/open-pencil/assets/${name}`);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /must not be served/u);
    }
    const backup = path.join(root, 'node_modules/.cache/cheshi-open-pencil/previous');
    await rename(options.output, backup);
    const duringPublication = await fetch(`${base}/open-pencil/assets/CanvasHistoryPanel-00000001.js`);
    assert.equal(duringPublication.status, 200);
    assert.match(await duringPublication.text(), /shared-00000001/u);
    await rename(backup, options.output);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
