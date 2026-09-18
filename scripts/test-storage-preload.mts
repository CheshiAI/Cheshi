import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests launched inside Cheshi inherit its real application data directory.
// Engine tests use their fixture-local indexes; CLI subprocesses that configure
// central storage instead resolve to this run's disposable application data.
const testDataRoot = mkdtempSync(path.join(os.tmpdir(), 'cheshi-test-storage-'));
delete process.env.CODEGRAPH_DATA_ROOT;
process.env.CHESHI_USER_DATA_DIR = testDataRoot;

afterAll(() => {
  rmSync(testDataRoot, { recursive: true, force: true });
});
