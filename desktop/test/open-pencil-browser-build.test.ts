import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { browserEditorAdaptations } from '../frontend/open-pencil/browser-adaptations';
import { browserDependencies } from '../frontend/open-pencil/browser-dependencies';

test('browser bundle compiles Tailwind imports and standalone HTML without Node filesystem APIs', async () => {
  const upstream = fileURLToPath(new URL('../../vendor/open-pencil/', import.meta.url));
  const entry = '\0cheshi-browser-test';
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'error',
    resolve: { alias: [
      { find: /^@open-pencil\/scene-graph$/, replacement: `${upstream}packages/scene-graph/src/index.ts` },
      { find: '#dom-css', replacement: `${upstream}packages/dom-css/src` },
    ] },
    plugins: [browserDependencies(), browserEditorAdaptations(), {
      name: 'browser-test-entry',
      resolveId(id) { return id === entry ? id : null; },
      load(id) {
        if (id !== entry) return null;
        return `export { compileTailwindCSS } from ${JSON.stringify(`${upstream}packages/dom-css/src/import/tailwind.ts`)};
export { exportHTMLBundle } from ${JSON.stringify(`${upstream}packages/dom-css/src/export/bundle.ts`)};`;
      },
    }],
    build: { write: false, target: 'esnext', minify: false,
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { format: 'iife', name: 'browserHelpers', inlineDynamicImports: true } } },
  });
  if (!('output' in result)) throw new Error('Expected one browser bundle');
  const chunk = result.output.find(item => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing browser test entry');
  expect(chunk.code).not.toContain('node:fs');
  expect(chunk.code).not.toContain('import.meta.resolve');
  // Deliberately no process, require or filesystem in the runtime environment.
  const helpers = runInNewContext(`${chunk.code}; browserHelpers`, { TextEncoder, TextDecoder, URL, console, crypto: globalThis.crypto }) as {
    compileTailwindCSS(classes: string, options?: { css: string }): Promise<string>;
    exportHTMLBundle(document: unknown, options: unknown): Promise<{ files: { content: string }[] }>;
  };
  const css = await helpers.compileTailwindCSS('flex p-4 bg-red-500');
  expect(css).toContain('display: flex');
  expect(css).toContain('.bg-red-500');
  const custom = await helpers.compileTailwindCSS('p-4', { css: '@import "tailwindcss/theme.css"; @import "tailwindcss/utilities.css";' });
  expect(custom).toContain('.p-4');
  const exported = await helpers.exportHTMLBundle({ type: 'document', children: [
    { type: 'element', tagName: 'div', attrs: { class: 'flex p-4' }, children: [{ type: 'text', text: 'Offline export' }] },
  ] }, { html: 'standalone', style: 'tailwind' });
  expect(exported.files[0]?.content).toContain('<!doctype html>');
  expect(exported.files[0]?.content).toContain('display: flex');
  expect(exported.files[0]?.content).toContain('Offline export');
}, 30000);
