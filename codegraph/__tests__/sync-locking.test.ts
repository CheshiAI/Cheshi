import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { FileLock, getCodeGraphDir, LockUnavailableError } from '../src';
import { WalCheckpointValve } from '../src/db/wal-valve';

const BIN = path.resolve(__dirname, '../src/bin/codegraph.ts');

async function expectRejection(
  operation: Promise<unknown>,
  validate: (error: unknown) => void,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    validate(error);
    return;
  }
  throw new Error('Expected operation to reject');
}

describe('sync lock contention', () => {
  let root: string;
  let cg: CodeGraph;
  let lock: FileLock;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-lock-'));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export function answer() { return 42; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    lock = new FileLock(path.join(getCodeGraphDir(root), 'codegraph.lock'));
  });

  afterEach(() => {
    lock.release();
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects with the typed lock error instead of returning an all-zero success shape', async () => {
    lock.acquire();
    await expectRejection(cg.sync(), (error) => {
      expect(error).toBeInstanceOf(LockUnavailableError);
      expect((error as Error).message).toMatch(/could not acquire the file lock/);
    });
  });

  it('makes the quiet git-hook CLI path exit nonzero when the lock is unavailable', () => {
    const before = cg.getStats();
    lock.acquire();

    const child = spawnSync(process.execPath, [BIN, 'sync', root, '--quiet'], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(child.status).toBe(1);
    expect(child.signal).toBeNull();
    const after = cg.getStats();
    expect({ files: after.fileCount, nodes: after.nodeCount, edges: after.edgeCount }).toEqual({
      files: before.fileCount,
      nodes: before.nodeCount,
      edges: before.edgeCount,
    });
  });

  it('releases the file lock when WAL teardown fails', async () => {
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    const drainSpy = spyOn(WalCheckpointValve.prototype, 'drain')
      .mockRejectedValueOnce(new Error('simulated WAL teardown failure'));

    try {
      await expectRejection(cg.sync(), (error) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('simulated WAL teardown failure');
      });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      drainSpy.mockRestore();
    }
  });

  it('releases the file lock when full-index WAL teardown fails', async () => {
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    const drainSpy = spyOn(WalCheckpointValve.prototype, 'drain')
      .mockRejectedValueOnce(new Error('simulated full-index WAL teardown failure'));

    try {
      await expectRejection(cg.indexAll(), (error) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('simulated full-index WAL teardown failure');
      });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      drainSpy.mockRestore();
    }
  });
});
