import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const assetTypes: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

async function readAsset(directory: string, name: string): Promise<Buffer | null> {
  try {
    const root = await realpath(directory);
    const filename = await realpath(path.join(root, name));
    if (path.dirname(filename) !== root) return null;
    return await readFile(filename);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

/** Built editor chunks are already transformed; Vite's public-file inventory can
 * lag behind the atomic directory swap used to publish a new editor build. */
export function openPencilDevAssets(previousAssetsDirectory: string): Plugin {
  return {
    name: 'cheshi-open-pencil-dev-assets',
    apply: 'serve',
    configureServer(server) {
      const directory = path.join(server.config.publicDir, 'open-pencil/assets');
      server.middlewares.use((request, response, next) => {
        const prefix = '/open-pencil/assets/';
        const url = request.url ?? '';
        if (!url.startsWith(prefix) || !['GET', 'HEAD'].includes(request.method ?? '')) return next();
        const serve = async () => {
          let name: string;
          try { name = decodeURIComponent(url.slice(prefix.length).split('?')[0]!); }
          catch { response.statusCode = 400; response.end(); return; }
          if (!/^[\w-][\w.-]*$/u.test(name)) { response.statusCode = 404; response.end(); return; }
          let content = await readAsset(directory, name);
          if (content === null) {
            // The previous tree is only a fallback during the publication gap,
            // never a way to resurrect an asset removed from a published build.
            const publishing = await realpath(directory).then(() => false, (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return true;
              throw error;
            });
            if (publishing) content = await readAsset(previousAssetsDirectory, name);
          }
          if (content === null) { response.statusCode = 404; response.end(); return; }
          response.setHeader('Content-Type', assetTypes[path.extname(name)] ?? 'application/octet-stream');
          response.setHeader('Content-Length', content.byteLength);
          response.setHeader('Cache-Control', 'no-cache');
          response.end(request.method === 'HEAD' ? undefined : content);
        };
        void serve().catch(next);
      });
    },
  };
}
