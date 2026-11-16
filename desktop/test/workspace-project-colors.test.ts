import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { workspaceProjectColors } from '../../config/workspace-project-colors.mts';
import { registerWorkspace } from '../../config/workspace-storage.mts';
import { WorkspaceManagementService } from '../lib/workspace-management-service.mts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cheshi-project-colors-'));
  const data = path.join(root, 'data');
  const projects = ['desktop', 'flash'].map(name => path.join(root, name));
  for (const project of projects) mkdirSync(project);
  return { root, data, projects };
}

test('automatic colors are distinct, persisted, and independent of list order and process lifetime', () => {
  const f = fixture();
  try {
    const colors = workspaceProjectColors(f.data, f.projects);
    assert.equal(new Set(colors).size, 2);
    assert.deepEqual(workspaceProjectColors(f.data, [...f.projects].reverse()), [...colors].reverse());
    const filename = path.join(f.data, 'project-colors.json');
    const saved = readFileSync(filename, 'utf8');
    const module = fileURLToPath(new URL('../../config/workspace-project-colors.mts', import.meta.url));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {workspaceProjectColors}=await import(${JSON.stringify(module)});console.log(JSON.stringify(workspaceProjectColors(${JSON.stringify(f.data)},${JSON.stringify(f.projects)})))`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), colors);
    assert.equal(readFileSync(filename, 'utf8'), saved);
    const third = path.join(f.root, 'third');
    mkdirSync(third);
    const expanded = workspaceProjectColors(f.data, [...f.projects, third]);
    assert.deepEqual(expanded.slice(0, 2), colors);
    assert.equal(new Set(expanded).size, 3);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('renaming or moving the same directory preserves its assigned color', () => {
  const f = fixture();
  try {
    const colors = workspaceProjectColors(f.data, f.projects);
    const destination = path.join(f.root, 'renamed-project');
    renameSync(f.projects[0]!, destination);
    assert.equal(workspaceProjectColors(f.data, [destination])[0], colors[0]);
    assert.equal(workspaceProjectColors(f.data, [f.projects[0]!])[0], colors[0]);
    assert.deepEqual(workspaceProjectColors(f.data, [destination, f.projects[1]!]), colors);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('existing registry entries receive shared catalog colors without indexing or changing project identity', async () => {
  const f = fixture();
  try {
    const registered = f.projects.map(root => registerWorkspace(f.data, root));
    const service = new WorkspaceManagementService(f.data);
    const catalog = (await service.list()).workspaces;
    for (const entry of catalog) {
      const original = registered.find(project => project.id === entry.id)!;
      assert.equal(entry.iconColor, original.iconColor);
      assert.equal(entry.iconColor, workspaceProjectColors(f.data, [entry.rootPath])[0]);
    }
    // A legacy installation has registrations but no color-assignment file.
    rmSync(path.join(f.data, 'project-colors.json'));
    const migrated = (await new WorkspaceManagementService(f.data).list()).workspaces;
    assert.deepEqual(migrated.map(entry => entry.id), catalog.map(entry => entry.id));
    assert.equal(new Set(migrated.map(entry => entry.iconColor)).size, 2);
    assert.deepEqual((await service.list()).workspaces, migrated);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('palette exhaustion reuses colors evenly without changing existing assignments', () => {
  const f = fixture();
  try {
    const roots = Array.from({ length: 25 }, (_, index) => path.join(f.root, `project-${index}`));
    const first = workspaceProjectColors(f.data, roots.slice(0, 12));
    assert.equal(new Set(first).size, 12);
    const all = workspaceProjectColors(f.data, roots);
    assert.deepEqual(all.slice(0, 12), first);
    const counts = [...new Set(all)].map(color => all.filter(value => value === color).length);
    assert.equal(Math.max(...counts) - Math.min(...counts), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('malformed saved color records fail without resetting or overwriting assignments', () => {
  const f = fixture();
  try {
    workspaceProjectColors(f.data, f.projects);
    const filename = path.join(f.data, 'project-colors.json');
    const invalid = JSON.stringify({ version: 1, projects: [{ roots: ['/project'], identity: null, hue: 'invalid' }] });
    writeFileSync(filename, invalid);
    assert.throws(() => workspaceProjectColors(f.data, f.projects), /Invalid project color configuration/);
    assert.equal(readFileSync(filename, 'utf8'), invalid);
    assert.throws(() => workspaceProjectColors('relative', f.projects), /absolute/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
