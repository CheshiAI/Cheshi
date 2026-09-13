import { CodeGraph } from '../src';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create a temporary directory for each test
export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// Clean up temporary directory
export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function cleanupGraphTest(cg: CodeGraph | undefined, tempDir: string): void {
  cg?.close();
  cleanupTempDir(tempDir);
}
