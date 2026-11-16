import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { officialAgentPackages, readAgentPackage } from '../lib/agent-management/packages.mts';
import { installHomiePack, installedHomiePacks, writeHomiePack } from '../lib/agent-management/homie-packs.mts';
import { preparePackEnvironment, packInstructions } from '../lib/agent-management/pack-environment.mts';
import { parseAgentPackage } from '../shared/agent-package';
import { installHomieSkills } from '../../experiments/codex-specialists/src/homie-pack-skills';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { specialistInput } from './agent-registry-fixtures';

async function pack() {
  const base = (await officialAgentPackages())[0]!;
  return { ...base, resources: { programs: ['python3', 'jq'], files: [
    { path: 'skills/check/SKILL.md', content: '---\nname: check\ndescription: Check changes.\n---\nRead scripts/check.ts.\n' },
    { path: 'skills/check/scripts/check.ts', content: 'console.log("checked");\n' },
    { path: 'scripts/run.sh', content: 'echo ready\n' },
  ] } };
}
async function fails(operation: Promise<unknown>, text: string) {
  let caught: unknown; try { await operation; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error); expect((caught as Error).message).toContain(text);
}
test('Homie packs round-trip assets and survive registry reload without source paths or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homie-pack-'));
  try {
    const definition = await pack();
    const filename = join(root, 'export.homiepack.json');
    await writeHomiePack(filename, definition);
    expect(await readAgentPackage(filename)).toEqual(definition);
    await installHomiePack(join(root, 'installed'), await readAgentPackage(filename));
    await rm(filename);
    expect(await installedHomiePacks(join(root, 'installed'))).toEqual([definition]);
    const registryFile = join(root, 'registry.json'), input = specialistInput();
    input.profile.package = definition;
    createAgentRegistry(registryFile).save(input, '/project');
    expect(createAgentRegistry(registryFile).snapshot('/project').agents[0]!.package).toEqual(definition);
    expect(await readFile(join(root, 'installed', `${definition.id}@${definition.version}.homiepack.json`), 'utf8')).not.toContain('accountId');
    await createSymbolicLink(registryFile, filename);
    await fails(readAgentPackage(filename), 'ELOOP');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('pack assets reject traversal, executable installation strings, duplicate paths and missing skill manifests', async () => {
  const definition = await pack();
  for (const path of ['../escape', 'scripts/../../escape', 'scripts//a', '/scripts/x', 'scripts/.hidden', 'scripts/a\\b', 'skills/review/helper.ts', 'skills/review/skill.md']) {
    expect(() => parseAgentPackage({ ...definition, resources: { files: [{ path, content: 'text' }], programs: [] } })).toThrow();
  }
  for (const programs of [['jq; curl x'], ['--allow-unauthenticated'], ['$(whoami)'], ['foo\nbar']]) {
    expect(() => parseAgentPackage({ ...definition, resources: { files: [], programs } })).toThrow();
  }
  for (const paths of [['scripts/a', 'scripts/a'], ['scripts/a', 'scripts/A'], ['scripts/a', 'scripts/a/b']]) {
    expect(() => parseAgentPackage({ ...definition, resources: { files: paths.map(path => ({ path, content: '' })), programs: [] } })).toThrow();
  }
  expect(parseAgentPackage(definition).resources!.programs).toEqual(['python3', 'jq']);
});
test('Docker pack environment uses a content-addressed cache and rebuilds only for changed assets or base', async () => {
  const definition = await pack();
  const cached = new Set<string>(); let baseId = 'sha256:base', builds = 0, context = '';
  const run: DockerCommand = async args => {
    if (args.includes('inspect')) return baseId;
    if (args.includes('ls')) return cached.has(args.at(-1)!) ? 'sha256:cached' : '';
    expect(args).toContain('build'); builds++; context = args.at(-1)!;
    const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends python3 jq');
    expect(dockerfile).toContain('USER node');
    expect(await readFile(join(context, 'assets/scripts/run.sh'), 'utf8')).toBe('echo ready\n');
    cached.add(args[args.indexOf('--tag') + 1]!); return '';
  };
  const [first, shared] = await Promise.all([preparePackEnvironment(run, [], 'cheshi:base', definition), preparePackEnvironment(run, [], 'cheshi:base', definition)]);
  expect(first).toBe(shared); expect(builds).toBe(1);
  await fails(readFile(join(context, 'Dockerfile')), 'ENOENT');
  expect(await preparePackEnvironment(run, [], 'cheshi:base', definition)).toBe(first); expect(builds).toBe(1);
  baseId = 'sha256:new'; expect(await preparePackEnvironment(run, [], 'cheshi:base', definition)).not.toBe(first); expect(builds).toBe(2);
  definition.resources.files[0]!.content += '\nUpdated.';
  await preparePackEnvironment(run, [], 'cheshi:base', definition); expect(builds).toBe(3);
  expect(await preparePackEnvironment(run, [], 'cheshi:base')).toBe('cheshi:base'); expect(builds).toBe(3);
  expect(packInstructions(definition)).toContain('/opt/cheshi/homie-pack/skills/check/SKILL.md');
});
test('worker installs native skills with their relative resources and removes only its own stale skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homie-skill-'));
  try {
    const home = join(root, 'codex'), source = join(root, 'pack');
    await mkdir(join(source, 'check/scripts'), { recursive: true });
    await writeFile(join(source, 'check/SKILL.md'), '---\nname: check\ndescription: Check changes.\n---\n');
    await writeFile(join(source, 'check/scripts/check.ts'), 'export {};');
    await mkdir(join(home, 'skills/personal'), { recursive: true });
    await mkdir(join(home, 'skills/cheshi-homie-old'));
    await installHomieSkills(home, source);
    expect((await readdir(join(home, 'skills'))).sort()).toEqual(['cheshi-homie-check', 'personal']);
    expect(await readFile(join(home, 'skills/cheshi-homie-check/scripts/check.ts'), 'utf8')).toBe('export {};');
    await installHomieSkills(home, join(root, 'missing'));
    expect((await readdir(join(home, 'skills'))).sort()).toEqual(['personal']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
