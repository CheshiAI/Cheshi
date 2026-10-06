import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';
import { createCodeGraphSynchronization } from '../lib/codegraph-synchronization.mts';
import { awaitManagedCodeGraphSync } from '../../codegraph/src/mcp/managed-sync.ts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(synchronize: () => Promise<void>, indexed = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-sync-'))); directories.push(root);
  const dataRoot = join(root, 'data');
  const database = join(codeGraphStorageDirectory(dataRoot, root), 'codegraph.db');
  if (indexed) { mkdirSync(join(database, '..'), { recursive: true }); writeFileSync(database, 'fixture'); }
  const owner = createCodeGraphSynchronization({ command: { executable: 'unused', args: [] }, dataRoot,
    createIndexer: () => ({ synchronize, stop: async () => {} }) });
  return { root, database, owner };
}
async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test('concurrent consumers share a writer; later queries check changes again', async () => {
  const started = createDeferred<void>(), release = createDeferred<void>();
  let calls = 0;
  const f = fixture(async () => { calls++; started.resolve(); await release.promise; });
  try {
    const first = f.owner.ensure(f.root); await started.promise;
    const second = f.owner.ensure(f.root);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
    release.resolve(); await Promise.all([first, second]);
    await f.owner.ensure(f.root); expect(calls).toBe(2);
  } finally { release.resolve(); await f.owner.dispose(); }
});

test('manual rebuilds serialize with sync, and a subsequent query waits behind the rebuild', async () => {
  const entered = createDeferred<void>(), release = createDeferred<void>();
  const events: string[] = [];
  const f = fixture(async () => { events.push('sync'); });
  try {
    const rebuild = f.owner.exclusive(f.root, async () => { events.push('rebuild'); entered.resolve(); await release.promise; events.push('rebuilt'); });
    await entered.promise;
    const query = f.owner.ensure(f.root);
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual(['rebuild']);
    release.resolve(); await Promise.all([rebuild, query]);
    expect(events).toEqual(['rebuild', 'rebuilt', 'sync']);
  } finally { release.resolve(); await f.owner.dispose(); }
});

test('failures propagate and do not poison the next synchronization', async () => {
  let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw new Error('writer busy'); });
  try {
    await fails(f.owner.ensure(f.root), 'writer busy');
    await f.owner.ensure(f.root); expect(calls).toBe(2);
    writeFileSync(`${f.database}.initializing`, 'incomplete');
    await fails(f.owner.ensure(f.root), 'incomplete'); expect(calls).toBe(2);
  } finally { await f.owner.dispose(); }
});

test('canceling a consumer does not stop synchronization needed by other queries', async () => {
  const entered = createDeferred<void>(), release = createDeferred<void>();
  let calls = 0;
  const f = fixture(async () => { calls++; entered.resolve(); await release.promise; });
  const controller = new AbortController();
  try {
    const first = f.owner.ensure(f.root, controller.signal);
    await entered.promise;
    const second = f.owner.ensure(f.root);
    controller.abort(new Error('query canceled'));
    await fails(first, 'query canceled');
    expect(calls).toBe(1);
    release.resolve(); await second;
    expect(calls).toBe(1);
  } finally { release.resolve(); await f.owner.dispose(); }
});

test('freshness does not initialize a missing index', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; }, false);
  try { await f.owner.ensure(f.root); expect(calls).toBe(0); }
  finally { await f.owner.dispose(); }
});

test('local MCP uses authenticated workspace-bound sync; errors prevent stale reads', async () => {
  let calls = 0, failed = false;
  const f = fixture(async () => { calls++; if (failed) throw new Error('private writer detail'); });
  try {
    const connection = await f.owner.connection(f.root);
    const env = { CHESHI_CODEGRAPH_SYNC_URL: connection.url, CHESHI_CODEGRAPH_SYNC_TOKEN: connection.token,
      CHESHI_CODEGRAPH_SYNC_WORKSPACE: connection.workspaceRoot };
    expect((await fetch(connection.url, { method: 'POST' })).status).toBe(403);
    expect((await fetch(connection.url, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, Origin: 'https://untrusted.test' } })).status).toBe(403);
    expect(calls).toBe(0);
    await awaitManagedCodeGraphSync(f.root, env); expect(calls).toBe(1);
    await awaitManagedCodeGraphSync(tmpdir(), env); expect(calls).toBe(1);
    failed = true;
    await fails(awaitManagedCodeGraphSync(f.root, env), 'synchronization failed');
    failed = false;
    await awaitManagedCodeGraphSync(undefined, env); expect(calls).toBe(3);
  } finally { await f.owner.dispose(); }
  await fails(f.owner.ensure(f.root), 'stopped');
});
