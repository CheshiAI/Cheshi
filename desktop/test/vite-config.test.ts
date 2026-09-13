import assert from 'node:assert/strict';
import test from 'node:test';

import viteConfig from '../frontend/vite.config.ts';

test('pre-bundles diagnostics worker dependencies before a Workspace file is opened', () => {
  const includedDependencies = viteConfig.optimizeDeps?.include;
  assert.ok(Array.isArray(includedDependencies));
  assert.ok(includedDependencies.includes('smol-toml'));
  assert.ok(includedDependencies.includes('typescript'));
});
