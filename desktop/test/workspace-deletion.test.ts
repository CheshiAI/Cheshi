import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { readWorkspaceRegistry, registerWorkspace, unregisterWorkspace } from '../../config/workspace-storage.mts';
import { deleteRegisteredWorkspace, type DeleteRegisteredWorkspaceOptions } from '../lib/workspace-deletion.mts';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cheshi-delete-workspace-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'project');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'notes.txt'), 'preserve this content');
  const entry = registerWorkspace(dataRoot, workspace, { setCurrent: true });
  const calls: string[] = [];
  const options: DeleteRegisteredWorkspaceOptions = {
    dataRoot, id: entry.id,
    confirm: async (record, exists) => {
      assert.equal(record.rootPath, workspace);
      assert.equal(exists, true);
      calls.push('confirm');
      return true;
    },
    trashItem: async (target) => {
      assert.equal(target, workspace);
      assert.ok(readWorkspaceRegistry(dataRoot).workspaces.some((record) => record.id === entry.id));
      calls.push('trash');
      renameSync(target, path.join(root, 'trashed'));
    },
    withDeletionLock: async (target, operation) => {
      assert.equal(target, workspace);
      calls.push('lock');
      try { return await operation(); } finally { calls.push('unlock'); }
    },
  };
  return { root, dataRoot, workspace, entry, calls, options };
}

test('moves the exact registered folder to trash before removing its registry entry', async (t) => {
  const f = fixture(t);
  assert.equal(await deleteRegisteredWorkspace(f.options), true);
  assert.deepEqual(f.calls, ['lock', 'confirm', 'trash', 'unlock']);
  assert.equal(existsSync(f.workspace), false);
  assert.equal(readFileSync(path.join(f.root, 'trashed', 'notes.txt'), 'utf8'), 'preserve this content');
  assert.equal(readWorkspaceRegistry(f.dataRoot).currentWorkspaceId, null);
  assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
  assert.ok(existsSync(f.entry.storagePath), 'central workspace data is retained');
});

test('cancel leaves the folder and registration intact and releases the lock', async (t) => {
  const f = fixture(t);
  f.options.confirm = async () => false;
  assert.equal(await deleteRegisteredWorkspace(f.options), false);
  assert.ok(existsSync(f.workspace));
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
  assert.deepEqual(f.calls, ['lock', 'unlock']);
});

test('trash failures preserve registration and release the lock', async (t) => {
  const f = fixture(t);
  f.options.trashItem = async () => { throw new Error('Trash unavailable'); };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /Trash unavailable/u);
  assert.ok(existsSync(f.workspace));
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
  assert.deepEqual(f.calls, ['lock', 'confirm', 'unlock']);
});

test('unknown and malformed IDs cannot supply a deletion path', async (t) => {
  const f = fixture(t);
  for (const id of [f.workspace, 'unknown', '', null, { rootPath: f.workspace }]) {
    await assert.rejects(deleteRegisteredWorkspace({ ...f.options, id }), /workspace ID|Workspace not found/u);
  }
  assert.deepEqual(f.calls, []);
  assert.ok(existsSync(f.workspace));
});

test('an active workspace lock rejects without prompting or trashing', async (t) => {
  const f = fixture(t);
  f.options.withDeletionLock = async () => { throw new Error('Workspace is open'); };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /Workspace is open/u);
  assert.deepEqual(f.calls, []);
});

test('missing folders can be removed from the list after explicit confirmation', async (t) => {
  const f = fixture(t);
  renameSync(f.workspace, path.join(f.root, 'moved'));
  f.options.confirm = async (entry, exists) => {
    assert.equal(entry.id, f.entry.id);
    assert.equal(exists, false);
    return true;
  };
  assert.equal(await deleteRegisteredWorkspace(f.options), true);
  assert.deepEqual(f.calls, ['lock', 'unlock']);
  assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
  assert.ok(existsSync(path.join(f.root, 'moved', 'notes.txt')));
});

test('new folders appearing during missing-folder confirmation are not deleted', async (t) => {
  const f = fixture(t);
  renameSync(f.workspace, path.join(f.root, 'moved'));
  f.options.confirm = async () => { mkdirSync(f.workspace); return true; };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /folder changed/u);
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
  assert.ok(!f.calls.includes('trash'));
});

test('a root replaced during confirmation is not deleted', async (t) => {
  const f = fixture(t);
  f.options.confirm = async () => {
    renameSync(f.workspace, path.join(f.root, 'original'));
    mkdirSync(f.workspace);
    return true;
  };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /folder changed/u);
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
  assert.ok(!f.calls.includes('trash'));
});

test('a symbolic-link replacement cannot redirect deletion to another folder', async (t) => {
  const f = fixture(t);
  const moved = path.join(f.root, 'original');
  renameSync(f.workspace, moved);
  createSymbolicLink(moved, f.workspace, 'dir');
  await assert.rejects(deleteRegisteredWorkspace(f.options), /symbolic link/u);
  assert.deepEqual(f.calls, []);
  assert.ok(existsSync(path.join(moved, 'notes.txt')));
});

test('symbolic links introduced during confirmation are rejected', async (t) => {
  const f = fixture(t);
  f.options.confirm = async () => {
    const moved = path.join(f.root, 'original');
    renameSync(f.workspace, moved);
    createSymbolicLink(moved, f.workspace, 'dir');
    return true;
  };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /symbolic link/u);
  assert.ok(!f.calls.includes('trash'));
});

test('non-directory path errors are not treated as a missing folder', async (t) => {
  const f = fixture(t);
  const child = path.join(f.workspace, 'child');
  mkdirSync(child);
  const entry = registerWorkspace(f.dataRoot, child);
  renameSync(f.workspace, path.join(f.root, 'moved'));
  writeFileSync(f.workspace, 'not a directory');
  await assert.rejects(deleteRegisteredWorkspace({ ...f.options, id: entry.id }), /ENOTDIR/u);
  assert.deepEqual(f.calls, []);
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 2);
});

test('registered descendants block parent deletion including children registered during confirmation', async (t) => {
  const f = fixture(t);
  const child = path.join(f.workspace, 'child');
  mkdirSync(child);
  f.options.confirm = async () => { registerWorkspace(f.dataRoot, child); return true; };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /another registered workspace/u);
  f.calls.length = 0;
  await assert.rejects(deleteRegisteredWorkspace(f.options), /another registered workspace/u);
  assert.deepEqual(f.calls, ['lock', 'unlock']);
  assert.ok(existsSync(f.workspace));
});

test('registry removal preserves concurrent additions and their current selection', async (t) => {
  const f = fixture(t);
  const trash = f.options.trashItem;
  const second = path.join(f.root, 'second');
  mkdirSync(second);
  let secondId = '';
  f.options.trashItem = async (target) => {
    await trash(target);
    secondId = registerWorkspace(f.dataRoot, second, { setCurrent: true }).id;
  };
  assert.equal(await deleteRegisteredWorkspace(f.options), true);
  const registry = readWorkspaceRegistry(f.dataRoot);
  assert.deepEqual(registry.workspaces.map((entry) => entry.id), [secondId]);
  assert.equal(registry.currentWorkspaceId, secondId);
});

test('registration removed during confirmation prevents trash', async (t) => {
  const f = fixture(t);
  f.options.confirm = async () => { unregisterWorkspace(f.dataRoot, f.entry); return true; };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /Workspace not found/u);
  assert.ok(!f.calls.includes('trash'));
  assert.ok(existsSync(f.workspace));
});

test('registry identity changes cannot remove a different record', async (t) => {
  const f = fixture(t);
  const registryPath = path.join(f.dataRoot, 'workspaces.json');
  const registry = readWorkspaceRegistry(f.dataRoot);
  writeFileSync(registryPath, JSON.stringify({ ...registry, workspaces: [{ ...f.entry, rootPath: f.root }] }));
  assert.throws(() => unregisterWorkspace(f.dataRoot, f.entry), /registered workspace changed/u);
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces[0]?.rootPath, f.root);
});

test('root, home, app ancestors and application data folders are protected', async (t) => {
  const f = fixture(t);
  for (const target of [path.parse(f.root).root, homedir(), f.dataRoot, f.entry.storagePath, f.root]) {
    const entry = registerWorkspace(f.dataRoot, target);
    await assert.rejects(deleteRegisteredWorkspace({ ...f.options, id: entry.id }), /protected/u);
  }
  await assert.rejects(deleteRegisteredWorkspace({
    ...f.options, protectedPaths: [path.join(f.workspace, 'app', 'main.mts')],
  }), /protected/u);
  assert.deepEqual(f.calls, []);
  assert.ok(existsSync(f.workspace));
});

function addIndex(f: ReturnType<typeof fixture>) {
  mkdirSync(f.entry.codeGraphPath);
  for (const name of ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db.initializing']) {
    writeFileSync(path.join(f.entry.codeGraphPath, name), name);
  }
  writeFileSync(path.join(f.entry.storagePath, 'chat-history.json'), 'saved conversations');
  const trash = f.options.trashItem;
  f.options.trashItem = async (target) => {
    if (target !== f.entry.codeGraphPath) return trash(target);
    assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
    f.calls.push('trash-index');
    renameSync(target, path.join(f.root, 'trashed-index'));
  };
}

test('deletes the entire CodeGraph directory after the project while retaining chat data', async (t) => {
  const f = fixture(t);
  addIndex(f);
  assert.equal(await deleteRegisteredWorkspace(f.options), true);
  assert.deepEqual(f.calls, ['lock', 'confirm', 'trash', 'trash-index', 'unlock']);
  assert.equal(existsSync(f.entry.codeGraphPath), false);
  assert.ok(existsSync(path.join(f.root, 'trashed-index', 'codegraph.db-wal')));
  assert.equal(readFileSync(path.join(f.entry.storagePath, 'chat-history.json'), 'utf8'), 'saved conversations');
  assert.ok(existsSync(path.join(f.entry.storagePath, 'workspace.json')));
});

test('cancellation and project trash failure preserve the CodeGraph index', async (t) => {
  const f = fixture(t);
  addIndex(f);
  f.options.confirm = async () => false;
  assert.equal(await deleteRegisteredWorkspace(f.options), false);
  assert.ok(existsSync(f.entry.codeGraphPath));
  f.options.confirm = async () => true;
  f.options.trashItem = async () => { throw new Error('Project trash failed'); };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /Project trash failed/u);
  assert.ok(existsSync(f.entry.codeGraphPath));
});

test('failed index deletion keeps a retryable registration after the project is gone', async (t) => {
  const f = fixture(t);
  addIndex(f);
  const trash = f.options.trashItem;
  f.options.trashItem = async (target) => {
    if (target === f.entry.codeGraphPath) throw new Error('Index trash failed');
    return trash(target);
  };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /CodeGraph index.*retry/u);
  assert.equal(existsSync(f.workspace), false);
  assert.ok(existsSync(f.entry.codeGraphPath));
  assert.equal(readWorkspaceRegistry(f.dataRoot).workspaces.length, 1);
  f.options.confirm = async (_entry, exists) => { assert.equal(exists, false); return true; };
  f.options.trashItem = trash;
  assert.equal(await deleteRegisteredWorkspace(f.options), true);
  assert.equal(existsSync(f.entry.codeGraphPath), false);
  assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
});

test('index symlink replacement stops deletion without touching its target', async (t) => {
  const f = fixture(t);
  addIndex(f);
  const elsewhere = path.join(f.root, 'other-index');
  f.options.confirm = async () => {
    renameSync(f.entry.codeGraphPath, elsewhere);
    createSymbolicLink(elsewhere, f.entry.codeGraphPath, 'dir');
    return true;
  };
  await assert.rejects(deleteRegisteredWorkspace(f.options), /CodeGraph storage path/u);
  assert.ok(existsSync(f.workspace));
  assert.ok(existsSync(path.join(elsewhere, 'codegraph.db')));
  assert.ok(!f.calls.includes('trash'));
});

test('index deletion ignores forged registry storage paths and preserves unrelated indexes', async (t) => {
  const f = fixture(t);
  addIndex(f);
  const other = path.join(f.root, 'other');
  mkdirSync(other);
  const otherEntry = registerWorkspace(f.dataRoot, other);
  mkdirSync(otherEntry.codeGraphPath);
  writeFileSync(path.join(otherEntry.codeGraphPath, 'codegraph.db'), 'other index');
  const registry = readWorkspaceRegistry(f.dataRoot);
  writeFileSync(path.join(f.dataRoot, 'workspaces.json'), JSON.stringify({ ...registry,
    workspaces: registry.workspaces.map((entry) => entry.id === f.entry.id
      ? { ...entry, codeGraphPath: otherEntry.codeGraphPath, storagePath: otherEntry.storagePath } : entry),
  }));
  f.options.trashItem = async (target) => {
    assert.ok(target === f.workspace || target === f.entry.codeGraphPath);
    renameSync(target, path.join(f.root, target === f.workspace ? 'trashed' : 'trashed-index'));
  };
  assert.equal(await deleteRegisteredWorkspace(f.options), true);
  assert.equal(existsSync(f.entry.codeGraphPath), false);
  assert.equal(readFileSync(path.join(otherEntry.codeGraphPath, 'codegraph.db'), 'utf8'), 'other index');
});
