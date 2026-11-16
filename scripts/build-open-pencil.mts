import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCachedEditor } from './open-pencil-build-cache.mts';
import { prepareOpenPencilSource } from './open-pencil-source.mts';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const started = performance.now();

try {
  const result = await buildCachedEditor({
    root, output: path.join(root, 'desktop/frontend/public/open-pencil'),
    inputs: ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'vendor/open-pencil.version.json',
      'desktop/frontend/package.json', 'desktop/frontend/open-pencil', 'desktop/frontend/src',
      'desktop/frontend/tsconfig.json', 'desktop/frontend/.env', 'desktop/frontend/.env.local',
      'desktop/frontend/.env.production', 'desktop/frontend/.env.production.local',
      'desktop/shared', 'desktop/frontend/public/canvas-fonts',
      'scripts/build-open-pencil.mts', 'scripts/open-pencil-build-cache.mts', 'scripts/open-pencil-source.mts'],
    toolchain: JSON.stringify({ node: process.versions.node, bun: process.versions.bun,
      platform: process.platform, arch: process.arch, vite: require('vite/package.json').version,
      nodeEnv: process.env.NODE_ENV ?? null,
      viteEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')).sort()) }),
    force: process.argv.includes('--force'),
    prepare: async () => { await prepareOpenPencilSource(root); },
    build: directory => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['run', 'vite', 'build', '--config', 'open-pencil/editor.vite.config.ts',
        '--configLoader', 'runner', '--outDir', directory], {
        cwd: path.join(root, 'desktop/frontend'), stdio: 'inherit', env: process.env,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve()
        : reject(new Error(`OpenPencil build failed (${signal ?? code}).`)));
    }),
  });
  console.log(`[open-pencil] ${result.reused ? 'Reused verified build' : 'Built editor'} (${Math.round(performance.now() - started)} ms)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
