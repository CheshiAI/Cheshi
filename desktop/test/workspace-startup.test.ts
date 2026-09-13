import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { codeGraphStorageDirectory, registerWorkspace } from '../../config/workspace-storage.mts';
import { canRestoreStartupWorkspace, resolveStartupWorkspace } from '../lib/workspace-startup.mts';

describe('startup workspace selection', () => {
  let temporaryRoot: string;
  let dataRoot: string;

  beforeEach(() => {
    temporaryRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'cheshi-startup-')));
    dataRoot = path.join(temporaryRoot, 'custom-app-data');
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function createWorkspace(name: string): string {
    const root = path.join(temporaryRoot, name);
    mkdirSync(root, { recursive: true });
    return root;
  }

  function createIndex(root: string, incomplete = false, indexDataRoot = dataRoot): void {
    const directory = codeGraphStorageDirectory(indexDataRoot, root);
    mkdirSync(directory, { recursive: true });
    const databasePath = path.join(directory, 'codegraph.db');
    writeFileSync(databasePath, 'index fixture');
    if (incomplete) writeFileSync(`${databasePath}.initializing`, 'incomplete');
  }

  it('leaves a new installation without a workspace and creates no app data', () => {
    const fallbackRoot = createWorkspace('development-checkout');

    assert.equal(resolveStartupWorkspace({ dataRoot, fallbackRoot }), null);
    assert.equal(existsSync(dataRoot), false);
  });

  it('does not use a filesystem root as the startup workspace even with a ready index', () => {
    const fallbackRoot = path.parse(temporaryRoot).root;
    createIndex(fallbackRoot);

    assert.equal(resolveStartupWorkspace({ dataRoot, fallbackRoot }), null);
    assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot: fallbackRoot }), null);
  });

  it('does not open a registered workspace that has no index', () => {
    const root = createWorkspace('registered-only');
    registerWorkspace(dataRoot, root, { setCurrent: true });

    assert.equal(resolveStartupWorkspace({ dataRoot }), null);
    assert.equal(existsSync(codeGraphStorageDirectory(dataRoot, root)), false);
  });

  it('restores the current indexed workspace ahead of more recently opened entries', () => {
    const current = createWorkspace('current');
    const recent = createWorkspace('recent');
    registerWorkspace(dataRoot, current, { setCurrent: true, timestamp: '2026-09-01T00:00:00Z' });
    registerWorkspace(dataRoot, recent, { timestamp: '2026-09-10T00:00:00Z' });
    createIndex(current);
    createIndex(recent);

    assert.equal(resolveStartupWorkspace({ dataRoot }), current);
  });

  it('prefers an indexed development fallback over the saved current workspace', () => {
    const current = createWorkspace('current');
    const fallbackRoot = createWorkspace('development-checkout');
    registerWorkspace(dataRoot, current, { setCurrent: true });
    createIndex(current);
    createIndex(fallbackRoot);

    assert.equal(resolveStartupWorkspace({ dataRoot, fallbackRoot }), fallbackRoot);
  });

  it('skips missing, unindexed, and incomplete entries and selects the most recent ready workspace', () => {
    const missing = createWorkspace('missing');
    const unindexed = createWorkspace('unindexed');
    const incomplete = createWorkspace('incomplete');
    const older = createWorkspace('a-older');
    const newer = createWorkspace('z-newer');
    registerWorkspace(dataRoot, missing, { setCurrent: true, timestamp: '2026-09-10T00:00:00Z' });
    registerWorkspace(dataRoot, unindexed, { timestamp: '2026-09-09T00:00:00Z' });
    registerWorkspace(dataRoot, incomplete, { timestamp: '2026-09-08T00:00:00Z' });
    registerWorkspace(dataRoot, older, { timestamp: '2026-09-01T00:00:00Z' });
    registerWorkspace(dataRoot, newer, { timestamp: '2026-09-07T00:00:00Z' });
    createIndex(missing);
    createIndex(incomplete, true);
    createIndex(older);
    createIndex(newer);
    rmSync(missing, { recursive: true });

    assert.equal(resolveStartupWorkspace({ dataRoot, fallbackRoot: path.parse(temporaryRoot).root }), newer);
  });

  it('returns no workspace when the only index is still initializing', () => {
    const root = createWorkspace('unfinished');
    registerWorkspace(dataRoot, root, { setCurrent: true });
    createIndex(root, true);

    assert.equal(resolveStartupWorkspace({ dataRoot, fallbackRoot: root }), null);
    assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot: root }), null);
  });

  it('honors an explicit indexed workspace ahead of both fallback and registry entries', () => {
    const workspaceRoot = createWorkspace('explicit');
    const current = createWorkspace('current');
    registerWorkspace(dataRoot, current, { setCurrent: true });
    createIndex(workspaceRoot);
    createIndex(current);

    assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot, fallbackRoot: current }), workspaceRoot);
  });

  it('does not fall back when the explicitly requested workspace is unindexed', () => {
    const workspaceRoot = createWorkspace('explicit-unindexed');
    const current = createWorkspace('current');
    registerWorkspace(dataRoot, current, { setCurrent: true });
    createIndex(current);

    assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot, fallbackRoot: current }), null);
  });

  it('rejects explicit relative paths, missing directories, and regular files', () => {
    const fileRoot = path.join(temporaryRoot, 'file');
    writeFileSync(fileRoot, 'not a directory');
    createIndex(fileRoot);
    const missingRoot = path.join(temporaryRoot, 'missing');
    createIndex(missingRoot);

    for (const workspaceRoot of ['relative-workspace', missingRoot, fileRoot]) {
      assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot }), null);
    }
  });

  it('uses the supplied central data root and ignores repository-local indexes', () => {
    const workspaceRoot = createWorkspace('workspace');
    const localIndex = path.join(workspaceRoot, '.codegraph');
    mkdirSync(localIndex);
    writeFileSync(path.join(localIndex, 'codegraph.db'), 'legacy index fixture');
    const otherDataRoot = path.join(temporaryRoot, 'other-app-data');
    createIndex(workspaceRoot, false, otherDataRoot);

    assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot }), null);
    assert.equal(resolveStartupWorkspace({ dataRoot: otherDataRoot, workspaceRoot }), workspaceRoot);
    createIndex(workspaceRoot);
    assert.equal(resolveStartupWorkspace({ dataRoot, workspaceRoot }), workspaceRoot);
  });
});

describe('startup restore prerequisites', () => {
  it('does not start an account server when a required tool is missing', async () => {
    for (const missing of ['codex', 'gh'] as const) {
      const tools = { platform: 'darwin', brew: true, gh: true, codex: true, [missing]: false };
      assert.equal(await canRestoreStartupWorkspace({
        getToolStatus: () => tools,
        createLogin: () => { throw new Error('Account server must not start'); },
      }), false);
    }
  });

  for (const state of ['signed_in', 'signed_out', 'error', 'checking', 'signing_in'] as const) {
    it(`restores only a confirmed signed-in account: ${state}`, async () => {
      const calls: string[] = [];
      const restore = await canRestoreStartupWorkspace({
        getToolStatus: () => ({ platform: 'darwin', brew: false, gh: true, codex: true }),
        createLogin: () => ({
          getStatus: async () => { calls.push('check'); return { state, error: null }; },
          dispose: async () => { calls.push('dispose'); },
        }),
      });
      assert.equal(restore, state === 'signed_in');
      assert.deepEqual(calls, ['check', 'dispose']);
    });
  }

  it('routes account check failures to the manager after shutting down the check server', async () => {
    let disposed = false;
    assert.equal(await canRestoreStartupWorkspace({
      getToolStatus: () => ({ platform: 'darwin', brew: true, gh: true, codex: true }),
      createLogin: () => ({
        getStatus: async () => { throw new Error('Mock account failure'); },
        dispose: async () => { disposed = true; },
      }),
    }), false);
    assert.equal(disposed, true);
  });

  it('does not start the next runtime if check-server cleanup fails', async () => {
    await assert.rejects(canRestoreStartupWorkspace({
      getToolStatus: () => ({ platform: 'darwin', brew: true, gh: true, codex: true }),
      createLogin: () => ({
        getStatus: async () => ({ state: 'signed_in', error: null }),
        dispose: async () => { throw new Error('Mock cleanup failure'); },
      }),
    }), /Mock cleanup failure/u);
  });
});
