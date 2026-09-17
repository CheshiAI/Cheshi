import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const preloadOutputDirectory = path.join(rootDirectory, 'desktop', 'runtime');

export const preloadOutputPath = path.join(preloadOutputDirectory, 'preload.cjs');

export async function buildDesktopPreload(): Promise<void> {
  mkdirSync(preloadOutputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: ['preload.cts', 'workspace-manager-preload.cts', 'selection-copy-preload.cts', 'account-usage-preload.cts'].map((name) => path.join(rootDirectory, 'desktop', name)),
    outdir: preloadOutputDirectory,
    naming: '[name].cjs',
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  if (result.success) return;

  const details = result.logs.map((message) => String(message)).join('\n');
  throw new Error(`Failed to build the desktop preload.${details ? `\n${details}` : ''}`);
}

if (import.meta.main) {
  await buildDesktopPreload();
  process.stdout.write(`Cheshi desktop preload built at ${preloadOutputPath}\n`);
}
