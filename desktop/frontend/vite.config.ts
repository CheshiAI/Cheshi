import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bundledDependencyNotices } from './open-pencil/dependency-notices.ts';
import { openPencilDevAssets } from './open-pencil/dev-assets.ts';
import { browserDependencies } from './open-pencil/browser-dependencies.ts';
import { viewerChunk } from './open-pencil/chunks.ts';

import { product } from '../../config/product.mts';

const viewerApiUrl = process.env.CHESHI_VIEWER_API_URL?.trim();
const productNameToken = '%CHESHI_PRODUCT_NAME%';
const inlineScriptPattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(inlineScriptPattern)].map((match) => {
    const script = match[1] ?? '';
    const digest = createHash('sha256').update(script).digest('base64');
    return `'sha256-${digest}'`;
  });
}

export function contentSecurityPolicy(html: string): string {
  const scriptSources = ["'self'", "'wasm-unsafe-eval'", ...new Set(inlineScriptHashes(html))].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

export default defineConfig({
  plugins: [
    openPencilDevAssets(fileURLToPath(new URL('../../node_modules/.cache/cheshi-open-pencil/previous/assets', import.meta.url))),
    bundledDependencyNotices(),
    browserDependencies(),
    react(),
    {
      name: 'cheshi-product-html',
      transformIndexHtml(html) {
        return html.replaceAll(productNameToken, product.displayName);
      },
    },
    {
      name: 'cheshi-content-security-policy',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: contentSecurityPolicy(html),
              },
              injectTo: 'head-prepend',
            },
          ];
        },
      },
    },
  ],
  base: './',
  define: {
    __CHESHI_PRODUCT__: JSON.stringify(product),
  },
  optimizeDeps: {
    entries: ['index.html'],
    include: ['smol-toml', 'typescript'],
  },
  server: {
    // Keep Vite's public-file inventory current for newly hashed assets, while
    // avoiding an editor rebuild reloading an open document via index.html HMR.
    watch: { ignored: ['**/public/open-pencil/index.html'] },
    ...(viewerApiUrl
    ? {
        proxy: {
          '/api': {
            target: viewerApiUrl,
            changeOrigin: true,
          },
        },
      }
    : {}),
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: viewerChunk, onlyExplicitManualChunks: true } },
  },
});
