import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

// Core itself must remain unbundled in development so Vite can transform its workers.
// Prebundle its dependencies explicitly, including the CommonJS libraries behind lazy imports.
const corePackage = createRequire(import.meta.url)('@open-pencil/core/package.json') as {
  dependencies: Record<string, string>;
};
export const openPencilOptimizedDependencies = Object.keys(corePackage.dependencies);

/** SDK 0.16 ships workers in src, but its compiled worker URLs still point inside dist. */
export function openPencilWorkerSources(): Plugin {
  return {
    name: 'cheshi-open-pencil-worker-sources',
    enforce: 'pre',
    transform(source, id) {
      const filename = id.split('?')[0]!;
      const marker = '/@open-pencil/core/dist/';
      const position = filename.indexOf(marker);
      if (position < 0 || !filename.endsWith('.js')) return null;
      const packageRoot = filename.slice(0, position) + '/@open-pencil/core';
      const result = source.replace(/new URL\("([^"\n]+\.ts)", import\.meta\.url\)/g, (expression, relative: string) => {
        const sourceFile = path.resolve(path.dirname(filename), relative).replace(`${packageRoot}/dist/`, `${packageRoot}/src/`);
        if (!sourceFile.startsWith(`${packageRoot}/src/`) || !existsSync(sourceFile)) return expression;
        const rewritten = path.relative(path.dirname(filename), sourceFile).split(path.sep).join('/');
        return `new URL(${JSON.stringify(rewritten)}, import.meta.url)`;
      });
      return result === source ? null : { code: result, map: null };
    },
  };
}
