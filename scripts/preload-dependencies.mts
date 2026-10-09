import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PRELOAD_ENTRYPOINTS = ['preload.cts', 'workspace-manager-preload.cts', 'selection-copy-preload.cts', 'account-usage-preload.cts', 'sticky-notes-preload.cts'];
/** Follow the same local imports as the bundle, including shared contracts and re-exports. */
export function preloadDependencies(root: string): string[] {
  const seen = new Set<string>(), scanner = new Bun.Transpiler({ loader: 'ts' });
  const visit = (filename: string) => {
    if (seen.has(filename)) return;
    seen.add(filename);
    for (const item of scanner.scanImports(readFileSync(filename, 'utf8'))) {
      if (item.path.startsWith('.')) visit(Bun.resolveSync(item.path, dirname(filename)));
    }
  };
  for (const name of PRELOAD_ENTRYPOINTS) visit(resolve(root, 'desktop', name));
  return [...seen];
}
/** Serialize bundle refresh before restart, even when main and shared files change together. */
export function preloadRefreshQueue(build: () => Promise<void>, restart: (path: string) => void, failed: (error: unknown) => void) {
  let queued = Promise.resolve();
  let revision = 0;
  return (path: string) => {
    const requested = ++revision;
    queued = queued.then(build).then(() => { if (requested === revision) restart(path); }).catch(failed);
    return queued;
  };
}
