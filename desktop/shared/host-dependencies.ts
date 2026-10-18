export interface HostDependencyLock { name: string; version: string; private: true; dependencies: Record<string, string> }

/** Only registry tarballs with locked integrity; no Git, local files, scripts or workspaces. */
export function parseHostDependencyLock(content: string): HostDependencyLock {
  const lock = JSON.parse(content);
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('Managed dependencies require an npm v3 lockfile.');
  const root = lock.packages[''];
  if (!root || !root.dependencies || Object.keys(root).some(k => !['name', 'version', 'license', 'dependencies', 'engines'].includes(k))) throw new Error('Invalid managed dependency manifest.');
  const dependencies = root.dependencies;
  if (typeof dependencies !== 'object' || Array.isArray(dependencies) || !Object.keys(dependencies).length || Object.keys(dependencies).length > 20) throw new Error('Declare 1–20 managed dependencies.');
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/.test(name) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
      || lock.packages[`node_modules/${name}`]?.version !== version) throw new Error('Managed dependencies require exact locked versions.');
  }
  for (const [path, item] of Object.entries(lock.packages) as [string, Record<string, unknown>][]) {
    if (!path) continue;
    if (!/^node_modules\//.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\') || !item || item.link) throw new Error('Invalid managed dependency lock entry.');
    if (item.inBundle === true && item.resolved === undefined && item.integrity === undefined) {
      // npm records bundled files without a separate archive; the ancestor tarball covers them.
      const ancestors = path.split('/node_modules/');
      ancestors.pop();
      if (!ancestors.some((_, index) => typeof lock.packages[ancestors.slice(0, index + 1).join('/node_modules/')]?.integrity === 'string')) throw new Error('Bundled dependency has no pinned parent archive.');
      continue;
    }
    if (typeof item.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity) || typeof item.resolved !== 'string') throw new Error('Invalid managed dependency integrity.');
    const url = new URL(item.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz')) throw new Error('Managed dependencies must use integrity-pinned npm registry archives.');
  }
  return { name: 'cheshi-managed-host-service', version: '1.0.0', private: true, dependencies };
}
