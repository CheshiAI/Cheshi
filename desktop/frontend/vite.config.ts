import { createHash } from 'node:crypto';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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

function contentSecurityPolicy(html: string): string {
  const scriptSources = ["'self'", ...new Set(inlineScriptHashes(html))].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
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
    include: ['smol-toml', 'typescript'],
  },
  server: viewerApiUrl
    ? {
        proxy: {
          '/api': {
            target: viewerApiUrl,
            changeOrigin: true,
          },
        },
      }
    : undefined,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
