import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));

/** Record actual emitted modules so chunk decisions can be measured. */
export function editorBuildReport(): Plugin {
  return {
    name: 'cheshi-editor-build-report',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
        file: chunk.fileName, entry: chunk.isEntry, bytes: Buffer.byteLength(chunk.code),
        imports: chunk.imports, dynamicImports: chunk.dynamicImports,
        largestModules: Object.entries(chunk.modules).sort((a, b) => b[1].renderedLength - a[1].renderedLength)
          .slice(0, 20).map(([id, module]) => ({ id: id.replaceAll(workspace, ''), bytes: module.renderedLength })),
      }));
      this.emitFile({ type: 'asset', fileName: 'build-report.json', source: JSON.stringify(chunks, null, 2) });
    },
  };
}
