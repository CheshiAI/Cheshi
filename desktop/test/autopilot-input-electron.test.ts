import { strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

// Independent hidden fixture, local HTML only; never starts or controls the Cheshi app.
test('Chromium input preserves text and rejects stale, covered and unconfirmed targets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cheshi-autopilot-input-'));
  try {
    const environment: NodeJS.ProcessEnv = { ...process.env, CHESHI_AUTOPILOT_TEST_DATA: directory };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electronPath, [fileURLToPath(new URL('./autopilot-input-electron-fixture.mts', import.meta.url))], {
      env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    strictEqual(child.status, 0, child.error?.message || child.stderr || `Electron terminated with ${child.signal}`);
    strictEqual(child.stdout.includes('AUTOPILOT_INPUT_OK'), true, child.stdout || child.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
