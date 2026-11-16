import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { resolveFileIcon } from '../frontend/src/shared/file-icons/fileIconResolver';
import rules from '../frontend/src/shared/file-icons/fileIconRules.json';

const examples = [
  ['main.rs', 'rust'],
  ['App.tsx', 'jsx'],
  ['main.py', 'python'],
  ['foo.ts', 'typeScript'],
  ['package.json', 'npm'],
  ['Dockerfile', 'docker'],
  ['.env', 'envs'],
  ['.env.product', 'envs'],
  ['.env.signing', 'envs'],
  ['AGENTS.md', 'agents'],
  ['bun.lock', 'bunlock'],
  ['bun.lockb', 'bunlock'],
  ['bunfig.toml', 'toml'],
  ['forge.config.mts', 'typeScript'],
  ['qodana.yaml', 'qodana'],
  ['README.md', 'readme'],
  ['LICENSE', 'license'],
  ['CHANGELOG.md', 'changelog'],
  ['CONTRIBUTING.md', 'githubContributing'],
] as const;

test('matches language icons and specific project filenames before generic extensions', () => {
  for (const [name, icon] of examples) {
    expect(resolveFileIcon(`/workspace/${name}`, name)).toEqual({ icon });
  }
});

test('preserves case-insensitive matching and normalizes Windows paths', () => {
  expect(resolveFileIcon('/workspace/readme.MD', 'readme.MD')).toEqual({ icon: 'readme' });
  expect(resolveFileIcon('C:\\repo\\tests\\main.rs', 'main.rs')).toEqual({ icon: 'testrustfiles' });
  expect(resolveFileIcon('/repo/src/main.rs', 'main.rs')).toEqual({ icon: 'rust' });
});

test('uses TypeScript for mts, cts and jts ahead of tool-specific associations', () => {
  for (const name of ['main.mts', 'preload.cts', 'module.jts', 'FORGE.CONFIG.MTS', 'vite.config.cts']) {
    expect(resolveFileIcon(`/workspace/${name}`, name)).toEqual({ icon: 'typeScript' });
  }
  expect(resolveFileIcon('/workspace/forge.config.js', 'forge.config.js')).toEqual({ icon: 'electronforge' });
});

test('leaves unknown extensions and partial filename matches on the fallback icon', () => {
  expect(resolveFileIcon('blob.qzxwvv', 'blob.qzxwvv')).toBeNull();
  expect(resolveFileIcon('not-package.json', 'not-package.json')?.icon).not.toBe('npm');
});

test('every generated association points to an existing SVG with a viewBox', () => {
  for (const icon of new Set(rules.map((rule) => rule[1]))) {
    const asset = new URL(`../frontend/src/shared/file-icons/assets/${icon}.svg`, import.meta.url);
    expect(existsSync(asset)).toBe(true);
    expect(readFileSync(asset, 'utf8')).toMatch(/<svg\b[^>]*\bviewBox=/);
  }
  const assets = new URL('../frontend/src/shared/file-icons/assets/', import.meta.url);
  const referencedFiles = [...new Set(rules.map((rule) => `${rule[1]}.svg`))].sort();
  expect(readdirSync(assets).sort()).toEqual(referencedFiles);
});
