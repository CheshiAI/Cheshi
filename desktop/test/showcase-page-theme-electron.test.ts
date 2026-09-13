import { match, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const fixture = fileURLToPath(new URL('./showcase-page-theme-electron-fixture.ts', import.meta.url));

// Explicit native regression: an independent hidden window serves local HTML
// through its own HTTPS handler. It never contacts a site or the Cheshi app.
test('real Chromium preserves CSS inheritance and scoped theme updates', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-theme-electron-'));
  try {
    const environment: NodeJS.ProcessEnv = { ...process.env, CHESHI_THEME_TEST_USER_DATA: directory };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electronPath, [fixture], {
      env: environment, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    strictEqual(child.status, 0, child.error?.message || child.stderr || `Electron terminated with ${child.signal}`);
    match(child.stdout, /SHOWCASE_THEME_RESULT passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
