import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync as createSymbolicLink } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { projectDependencies, prepareDependencies } from '../lib/agent-management/dependencies.mts';
import { assertProjectEnvironment, prepareProjectEnvironment, writableProjectMount } from '../lib/agent-management/project-environment.mts';
const dirs: string[] = [];
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
function temporary() { const p = mkdtempSync(join(tmpdir(), 'cheshi-env-')); dirs.push(p); return p; }
async function failure(operation: Promise<unknown>, message: string) {
  let error: unknown; try { await operation; } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
test('manifest plan excludes host dependencies and credentials, preserves linker mode and invalidates on manifest edits', async () => {
  const root = temporary(); mkdirSync(join(root, 'frontend'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['frontend'] }));
  writeFileSync(join(root, 'frontend/package.json'), '{"name":"frontend"}'); writeFileSync(join(root, 'bun.lock'), '{}');
  writeFileSync(join(root, 'bunfig.toml'), '[install]\nlinker = "hoisted"\nregistry = "https://private/"\n[test]\npreload=["./secret.ts"]\n');
  writeFileSync(join(root, '.npmrc'), 'token=private');
  const before = projectDependencies(root)!;
  expect(before.files.map(f => f.path)).toEqual(['bun.lock', 'bunfig.toml', 'frontend/package.json', 'package.json']);
  expect(before.files.find(f => f.path === 'bunfig.toml')?.content).toBe('[install]\nlinker = "hoisted"\n');
  writeFileSync(join(root, 'frontend/package.json'), '{"name":"frontend","version":"2.0.0"}');
  expect(projectDependencies(root)!.fingerprint).not.toBe(before.fingerprint);
  const calls: string[][] = [];
  const prepared = await prepareDependencies(async args => {
    calls.push(args);
    if (args.includes('info')) return 'linux/arm64';
    if (args.includes('inspect')) return 'sha256:worker';
    if (args.includes('build')) {
      const context = args.at(-1)!;
      const dockerfile = readFileSync(join(context, 'Dockerfile'), 'utf8');
      expect(dockerfile).toContain('--frozen-lockfile --ignore-scripts');
      expect(dockerfile).toContain('BUN_INSTALL_CACHE_DIR=');
      expect(readFileSync(join(context, 'manifests/bunfig.toml'), 'utf8')).not.toContain('private');
    }
    return '';
  }, ['--context', 'test'], 'cheshi-specialist:1', before, 'cheshi-specialist-environment:1');
  expect(prepared.mounts).toHaveLength(4);
  expect(prepared.image).toBe('cheshi-specialist:1');
  expect(prepared.mounts.filter(m => m.startsWith('type=' )).every(m => m.endsWith(',readonly'))).toBe(true);
  expect(calls.some(c => c.includes('build'))).toBe(true);
});
test('worker code upgrades reuse dependency images and volumes; manifests and environment changes invalidate them', async () => {
  const root = temporary();
  writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'bun.lock'), '{}');
  const images = new Set<string>(), builds: string[] = [], seeds: string[][] = [];
  let environment = 'sha256:environment-v1';
  const run = async (args: string[]) => {
    if (args.includes('info')) return 'linux/arm64';
    if (args.includes('inspect')) { expect(args).toContain('environment'); return environment; }
    if (args.includes('ls')) return images.has(args.at(-1)!) ? 'cached' : '';
    if (args.includes('build')) {
      const image = args[args.indexOf('--tag') + 1]!; builds.push(image); images.add(image);
      expect(readFileSync(join(args.at(-1)!, 'Dockerfile'), 'utf8')).toStartWith('FROM environment\n');
    }
    if (args.includes('run')) seeds.push(args);
    return '';
  };
  const first = await prepareDependencies(run, [], 'worker-v1', projectDependencies(root), 'environment');
  const upgraded = await prepareDependencies(run, [], 'worker-v2', projectDependencies(root), 'environment');
  expect(builds).toHaveLength(1);
  expect(upgraded.image).toBe('worker-v2'); expect(upgraded.mounts).toEqual(first.mounts);
  expect(seeds).toHaveLength(2);
  expect(seeds[1]).toContain('--read-only'); expect(seeds[1]).toContain('none');
  writeFileSync(join(root, 'bun.lock'), '{"changed":true}');
  const changed = await prepareDependencies(run, [], 'worker-v2', projectDependencies(root), 'environment');
  expect(builds).toHaveLength(2); expect(changed.mounts).not.toEqual(first.mounts);
  environment = 'sha256:environment-v2';
  await prepareDependencies(run, [], 'worker-v2', projectDependencies(root), 'environment');
  expect(builds).toHaveLength(3);
});
test('a worker without command dependencies needs no dependency Docker operations', async () => {
  const prepared = await prepareDependencies(async () => { throw new Error('Unexpected dependency operation'); }, [], 'worker', null, 'environment');
  expect(prepared).toEqual({ image: 'worker', mounts: [] });
});
test('dependency preparation rejects manifests outside the project and frozen-lock failures', async () => {
  const root = temporary(), outside = temporary();
  writeFileSync(join(outside, 'package.json'), '{}');
  createSymbolicLink(join(outside, 'package.json'), join(root, 'package.json'));
  writeFileSync(join(root, 'bun.lock'), '{}');
  expect(() => projectDependencies(root)).toThrow('inside');
  await failure(prepareDependencies(async () => { throw new Error('offline'); }, [], 'worker', { workspace: root, fingerprint: 'hash', files: [], directories: [] }, 'environment'), 'offline');
});
test('project share changes only the exact project and does not alter unrelated mounts', () => {
  const source = 'cpu: 4\nmounts:\n  - location: /project\n    writable: false\n  - location: /other\n    writable: false\nssh:\n  agent: false\n';
  const result = writableProjectMount(source, '/project');
  expect(result).toBe(source.replace('location: /project\n    writable: false', 'location: /project\n    writable: true'));
  expect(writableProjectMount(result, '/project')).toBe(result);
  expect(writableProjectMount(source, '/new project')).toContain('location: "/new project"\n    writable: true');
});
test('VM setup refuses active containers and preflight verifies the actual mount, not only config', async () => {
  const prefix = ['--host', `unix://${join(homedir(), '.colima/cheshi/docker.sock')}`];
  let mutations = 0;
  await failure(prepareProjectEnvironment('docker:colima-cheshi', prefix, '/project', async () => 'running-container', async () => { mutations++; return ''; }), 'Stop all');
  expect(mutations).toBe(0);
  await failure(assertProjectEnvironment('docker:colima-cheshi', prefix, '/project', async () => 'ro,relatime\n'), 'Project setup required');
  await assertProjectEnvironment('docker:colima-cheshi', prefix, '/project', async () => 'rw,relatime\n');
  await failure(assertProjectEnvironment('docker:colima-cheshi', ['--host', 'unix:///foreign.sock'], '/project', async () => 'rw'), 'identity');
});

test('packaging retains the environment services and their worker contract', async () => {
  const { loadForgeConfiguration } = await import('./forge-test-helpers.ts');
  const config = await loadForgeConfiguration(), ignore = config.packagerConfig.ignore;
  if (typeof ignore !== 'function') throw new Error('Missing packaging filter');
  for (const path of ['/desktop/lib/agent-management/dependencies.mts', '/desktop/lib/agent-management/project-environment.mts', '/experiments/codex-specialists/src/execution-permissions.ts', '/experiments/codex-specialists/src/protocol.ts']) expect(ignore(path)).toBe(false);
});
