import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink as createSymbolicLink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readWorkspaceRegistry } from '../../config/workspace-storage.mts';
import { WorkspaceManagementService } from '../lib/workspace-management-service.mts';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cheshi-create-project-'));
  const parent = path.join(root, 'projects');
  const dataRoot = path.join(root, 'data');
  await mkdir(parent);
  return { root, parent, dataRoot, service: new WorkspaceManagementService(dataRoot) };
}

async function rejects(operation: Promise<unknown>, pattern?: RegExp): Promise<void> {
  let rejected = false;
  try { await operation; } catch (error) {
    rejected = true;
    assert.ok(error instanceof Error);
    if (pattern) assert.match(error.message, pattern);
  }
  assert.equal(rejected, true, 'Expected operation to reject');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function creationFailureInHome(dataRoot: string, parentPath: string, home: string): string {
  const script = `
    const { WorkspaceManagementService } = await import(${JSON.stringify(new URL('../lib/workspace-management-service.mts', import.meta.url).href)});
    const service = new WorkspaceManagementService(${JSON.stringify(dataRoot)});
    try {
      await service.createProject(${JSON.stringify({ parentPath, directoryName: 'failed' })});
      process.exitCode = 2;
    } catch (error) { process.stdout.write(error.message); }
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home }, encoding: 'utf8',
  });
}

test('new projects initialize an empty Git repository and register without commits, remotes, or indexing', async () => {
  const f = await fixture();
  try {
    const result = await f.service.createProject({ parentPath: f.parent, directoryName: 'My 새 Project' });
    assert.equal(result.rootPath, await realpath(path.join(f.parent, 'My 새 Project')));
    assert.equal(result.name, 'My 새 Project');
    assert.equal(result.available, true);
    assert.equal(result.isGitRepository, true);
    assert.equal(git(result.rootPath, 'rev-parse', '--show-toplevel'), result.rootPath);
    assert.equal(git(result.rootPath, 'remote'), '');
    assert.equal(git(result.rootPath, 'status', '--porcelain'), '');
    assert.throws(() => git(result.rootPath, 'rev-parse', '--verify', 'HEAD'));
    assert.deepEqual(await readdir(result.rootPath), ['.git']);
    const registry = readWorkspaceRegistry(f.dataRoot);
    assert.equal(registry.currentWorkspaceId, null);
    assert.equal(registry.workspaces.length, 1);
    assert.equal(existsSync(registry.workspaces[0]!.codeGraphPath), false);
    assert.deepEqual((await new WorkspaceManagementService(f.dataRoot).list()).workspaces, [result]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('new projects preserve existing folders, files, and symbolic link destinations', async () => {
  const f = await fixture();
  try {
    const existing = path.join(f.parent, 'existing');
    await mkdir(existing);
    await writeFile(path.join(existing, 'keep.txt'), 'keep');
    await writeFile(path.join(f.parent, 'file'), 'file content');
    await createSymbolicLink(existing, path.join(f.parent, 'link'), 'dir');
    for (const directoryName of ['existing', 'file', 'link']) {
      await rejects(f.service.createProject({ parentPath: f.parent, directoryName }), /already exists/u);
    }
    assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(f.parent, 'file'), 'utf8'), 'file content');
    assert.deepEqual((await f.service.list()).workspaces, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('new project inputs reject invalid names and parent paths before creating anything', async () => {
  const f = await fixture();
  try {
    for (const directoryName of ['', ' ', '.', '..', '../escape', 'nested/path', 'nested\\path', '-option', 'c:drive', 'name\0', null, true]) {
      await rejects(f.service.createProject({ parentPath: f.parent, directoryName }));
    }
    for (const parentPath of ['', 'relative', path.join(f.root, 'missing'), null, true, f.parent + '\0']) {
      await rejects(f.service.createProject({ parentPath, directoryName: 'project' }));
    }
    for (const request of [null, [], '', true]) await rejects(f.service.createProject(request));
    assert.deepEqual(await readdir(f.parent), []);
    assert.deepEqual((await f.service.list()).workspaces, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('exclusive creation preserves a destination appearing after validation', async () => {
  const f = await fixture();
  try {
    const service = new WorkspaceManagementService(f.dataRoot, undefined, (destination) => {
      mkdirSync(destination);
      writeFileSync(path.join(destination, 'concurrent.txt'), 'external content');
    });
    await rejects(service.createProject({ parentPath: f.parent, directoryName: 'project' }), /EEXIST/u);
    assert.equal(await readFile(path.join(f.parent, 'project', 'concurrent.txt'), 'utf8'), 'external content');
    assert.equal(existsSync(path.join(f.parent, 'project', '.git')), false);
    assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a failed Git initialization removes only an empty newly created folder and registers nothing', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, 'home');
    await mkdir(home);
    await writeFile(path.join(home, '.gitconfig'), '[invalid config');
    const output = creationFailureInHome(f.dataRoot, f.parent, home);
    assert.match(output, /bad config/u);
    assert.equal(existsSync(path.join(f.parent, 'failed')), false);
    assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
    assert.equal((await f.service.createProject({ parentPath: f.parent, directoryName: 'failed' })).isGitRepository, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('partial Git initialization failures preserve their nonempty folder and report its location', async () => {
  const f = await fixture();
  try {
    const home = path.join(f.root, 'home');
    const template = path.join(f.root, 'template');
    await mkdir(home);
    await mkdir(template);
    await writeFile(path.join(template, 'config'), '[invalid config');
    await writeFile(path.join(home, '.gitconfig'), `[init]\n\ttemplateDir = ${JSON.stringify(template)}\n`);
    const output = creationFailureInHome(f.dataRoot, f.parent, home);
    assert.match(output, /unfinished project folder was preserved at/u);
    assert.ok(output.includes(path.join(f.parent, 'failed')));
    assert.equal(existsSync(path.join(f.parent, 'failed', '.git')), true);
    assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
    await rejects(f.service.createProject({ parentPath: f.parent, directoryName: 'failed' }), /already exists/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('registration failure preserves the completed project and explains how to add it again', async () => {
  const f = await fixture();
  try {
    let checks = 0;
    const service = new WorkspaceManagementService(f.dataRoot, undefined, () => {
      checks += 1;
      if (checks > 1) throw new Error('Workspace is being deleted');
    });
    await rejects(service.createProject({ parentPath: f.parent, directoryName: 'ready' }), /created at.*Open folder/u);
    const destination = path.join(f.parent, 'ready');
    assert.equal(git(destination, 'rev-parse', '--is-inside-work-tree'), 'true');
    assert.deepEqual(readWorkspaceRegistry(f.dataRoot).workspaces, []);
    assert.equal((await f.service.addFolder(destination)).isGitRepository, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('new project creation shares the workspace mutation gate and releases it after validation failure', async () => {
  const f = await fixture();
  try {
    const created = f.service.createProject({ parentPath: f.parent, directoryName: 'first' });
    await rejects(f.service.createProject({ parentPath: f.parent, directoryName: 'second' }), /in progress/u);
    await created;
    await rejects(f.service.createProject(null));
    assert.equal((await f.service.createProject({ parentPath: f.parent, directoryName: 'second' })).isGitRepository, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
