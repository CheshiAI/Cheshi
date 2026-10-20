import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Keep bundled dependency notices in the distributed renderer, including lazy chunks. */
export function bundledDependencyNotices(): Plugin {
  return {
    name: 'cheshi-bundled-dependency-notices',
    generateBundle() {
      const packages = new Set<string>();
      for (const id of this.getModuleIds()) {
        const marker = '/node_modules/';
        const position = id.lastIndexOf(marker);
        if (position < 0) continue;
        const segments = id.slice(position + marker.length).split('/');
        const name = segments.slice(0, segments[0]?.startsWith('@') ? 2 : 1).join('/');
        const root = id.slice(0, position + marker.length) + name;
        if (existsSync(path.join(root, 'package.json'))) packages.add(root);
      }
      const notices = [...packages].sort().map(root => {
        const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
          name: string; version: string; license?: string;
        };
        const files = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile()
          && /^(license|licence|copying|notice)([.-]|$)/i.test(entry.name));
        return [`${metadata.name} ${metadata.version} (${metadata.license ?? 'see package'})`,
          ...files.map(entry => readFileSync(path.join(root, entry.name), 'utf8'))].join('\n\n');
      });
      this.emitFile({ type: 'asset', fileName: 'third-party-notices.txt', source: notices.join('\n\n-----\n\n') });
    },
  };
}
