import { avatarPng } from './agent-avatar-image-fixtures';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm, symlink as createSymbolicLink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HomieSources } from '../lib/agent-management/homie-sources.mts';
import { readHomieSource, portableAgent, sourceFiles, sourceDigest } from '../lib/agent-management/homie-source-files.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { specialistInput, specialistModels } from './agent-registry-fixtures.ts';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';
import { HOMIE_SOURCE_CHANNEL } from '../shared/homie-source.ts';

async function rejected(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(message);
}
async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await rm(f.base, { recursive: true, force: true }); }
}
async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cheshi-source-')));
  const repository = join(base, 'homie'), workspace = join(base, 'project'), data = join(base, 'local');
  await mkdir(repository); await mkdir(workspace);
  const registry = createAgentRegistry(join(data, 'registry.json'));
  const input = specialistInput(); input.profile.accountId = 'default';
  input.assignment.permissions = { fileWrite: false, commandExecution: true };
  const agent = registry.save(input, workspace).snapshot.agents[0]!;
  const pack = portableAgent(agent);
  for (const [name, content] of Object.entries(sourceFiles(pack))) await writeFile(join(repository, name), content);
  const repositories = { local: async () => ({ agentId: agent.id, directory: repository, repository: 'example/homie', accountId: 1 }) };
  const sources = new HomieSources({ directory: join(data, 'sources'), registry, repositories });
  return { base, repository, workspace, data, registry, agent, pack, sources, repositories };
}

test('model settings update the manifest, preserve other files and reach the next worker preparation', async () => {
  await fixture(async f => {
    const prepared = await f.sources.prepare(f.workspace, f.agent.id);
    await f.sources.applied(f.workspace, f.agent.id, 'docker:test', prepared.hash);
    const agent = f.registry.snapshot(f.workspace).agents[0]!;
    const filename = join(f.repository, 'agent.json');
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    manifest.description = 'Edited independently';
    await writeFile(filename, JSON.stringify(manifest));
    await writeFile(join(f.repository, 'instructions.md'), 'Pending instructions from files.');
    const selection = { model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
    const input = { ...specialistInput(), id: agent.id, revision: agent.revision, profile: { ...agent, ...selection } };
    const saved = await f.sources.saveSettings(f.workspace, input);
    expect(saved.snapshot.agents[0]?.package?.model).toEqual(selection);
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ ...manifest, model: selection });
    expect(await readFile(join(f.repository, 'instructions.md'), 'utf8')).toBe('Pending instructions from files.');
    expect((await f.sources.status(f.workspace, agent.id, 'docker:test')).phase).toBe('pending');
    await rejected(f.sources.saveSettings(f.workspace, input), 'changed');
    const registry = createAgentRegistry(join(f.data, 'registry.json'));
    const restarted = new HomieSources({ directory: join(f.data, 'sources'), registry, repositories: f.repositories });
    const next = await restarted.prepare(f.workspace, agent.id);
    expect(next.pack.model).toEqual(selection);
    expect(registry.snapshot(f.workspace).agents[0]?.reasoningEffort).toBe('high');
    expect(next.pack.instructions).toBe('Pending instructions from files.');
  });
});

test('model saves reject conflicting file changes and roll back when the registry or owner rejects saving', async () => {
  await fixture(async f => {
    await f.sources.status(f.workspace, f.agent.id);
    const filename = join(f.repository, 'agent.json'), original = await readFile(filename, 'utf8');
    const selection = { model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
    const input = { ...specialistInput(), id: f.agent.id, revision: f.agent.revision, profile: { ...f.agent, ...selection } };
    const manifest = JSON.parse(original);
    await writeFile(filename, JSON.stringify({ ...manifest, model: { ...selection, reasoningEffort: 'medium' } }));
    const conflict = await readFile(filename, 'utf8');
    await rejected(f.sources.saveSettings(f.workspace, input), 'Model settings changed');
    expect(await readFile(filename, 'utf8')).toBe(conflict);
    await writeFile(filename, original);
    f.registry.save({ ...specialistInput(), profile: { ...specialistInput().profile, name: 'Other' } }, f.workspace);
    await rejected(f.sources.saveSettings(f.workspace, { ...input, profile: { ...input.profile, displayName: 'Other' } }), 'already exists');
    expect(await readFile(filename, 'utf8')).toBe(original);
    let calls = 0;
    await rejected(f.sources.saveSettings(f.workspace, input, () => {
      if (++calls === 3) throw new Error('Owner closed');
    }), 'Owner closed');
    expect(await readFile(filename, 'utf8')).toBe(original);
    expect(f.registry.snapshot(f.workspace).agents.find(agent => agent.id === f.agent.id)?.model).toBeNull();
    expect((await readdir(f.repository)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});

test('repository changes are applied from disk, preserve local bindings, and survive service restart', async () => {
  await fixture(async f => {
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('pending');
    await writeFile(join(f.repository, 'instructions.md'), 'Verify only the submitted implementation.');
    const manifest = JSON.parse(await readFile(join(f.repository, 'agent.json'), 'utf8'));
    manifest.name = 'Verification'; manifest.role = 'verification'; manifest.requestedPermissions = { fileWrite: true, commandExecution: true };
    await writeFile(join(f.repository, 'agent.json'), JSON.stringify(manifest));
    await mkdir(join(f.repository, 'skills', 'checks'), { recursive: true });
    await writeFile(join(f.repository, 'skills', 'checks', 'SKILL.md'), '---\nname: checks\ndescription: checks\n---\nRun the checks.');
    const prepared = await f.sources.prepare(f.workspace, f.agent.id);
    const saved = f.registry.snapshot(f.workspace).agents[0]!;
    expect(saved.name).toBe('Verification'); expect(saved.role).toBe('verification');
    expect(saved.instructions).toBe('Verify only the submitted implementation.');
    expect(saved.accountId).toBe('default'); expect(saved.permissions).toEqual(f.agent.permissions);
    expect(saved.assignments).toEqual(f.agent.assignments);
    expect(saved.package?.resources?.files[0]?.path).toBe('skills/checks/SKILL.md');
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('pending');
    await f.sources.applied(f.workspace, f.agent.id, 'docker:test', prepared.hash);
    const restarted = new HomieSources({ directory: join(f.data, 'sources'), registry: f.registry, repositories: f.repositories });
    expect((await restarted.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('applied');
    expect((await restarted.status(f.workspace, f.agent.id, 'docker:other')).phase).toBe('pending');
    await writeFile(join(f.repository, 'instructions.md'), 'A newer version.');
    expect((await restarted.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('pending');
  });
});

test('invalid source does not fall back to stale settings or overwrite the validated cache', async () => {
  await fixture(async f => {
    await f.sources.prepare(f.workspace, f.agent.id);
    const previous = f.registry.snapshot(f.workspace);
    await writeFile(join(f.repository, 'agent.json'), '{ malformed');
    const invalid = await f.sources.status(f.workspace, f.agent.id);
    expect(invalid.phase).toBe('invalid'); expect(invalid.message).toContain('agent.json:');
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'JSON');
    expect(f.registry.snapshot(f.workspace)).toEqual(previous);
  });
});

test('source IPC enforces window ownership and local saves cannot overwrite repository configuration', async () => {
  await fixture(async f => {
    const owner = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
    const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
    const bridge = registerAgentRegistryIpc({ window, registry: f.registry, workspaceRoot: f.workspace,
      source: input => f.sources.status(f.workspace, input.agentId, input.engineId),
      models: async () => specialistModels(),
      saveSettings: (input, available) => f.sources.saveSettings(f.workspace, input, available),
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
    const api = createAgentRegistryApi(Object.assign(new EventEmitter(), {
      invoke: async (channel: string, value?: unknown) => handlers.get(channel)!(event, value),
    }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
    try {
      const input = { agentId: f.agent.id, action: 'status' as const, engineId: 'docker:test' };
      const handler = handlers.get(HOMIE_SOURCE_CHANNEL)!;
      expect(() => handler({ ...event, sender: {} } as IpcMainInvokeEvent, input)).toThrow('workspace window');
      expect(() => handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent, input)).toThrow('workspace window');
      expect((await api.source!(input)).phase).toBe('pending');
      const originalManifest = await readFile(join(f.repository, 'agent.json'), 'utf8');
      await api.save({ ...specialistInput(), id: f.agent.id, revision: f.agent.revision,
        profile: { ...f.agent, name: 'Stale form name', displayName: 'Dwight', avatar: { character: 'sprout', color: 'mint', image: avatarPng }, instructions: 'Stale form instructions', accountId: null },
        assignment: { assigned: true, instructions: '', permissions: { fileWrite: true, commandExecution: false } } });
      const saved = f.registry.snapshot(f.workspace).agents[0]!;
      expect(saved.name).toBe(f.agent.name); expect(saved.instructions).toBe(f.agent.instructions);
      expect(saved.displayName).toBe('Dwight'); expect(saved.avatar?.image).toBe(avatarPng);
      expect(saved.accountId).toBeNull();
      expect(saved.assignments[0]?.permissions).toEqual({ fileWrite: true, commandExecution: false });
      expect(await readFile(join(f.repository, 'agent.json'), 'utf8')).toBe(originalManifest);
      const snapshot = f.registry.snapshot(f.workspace), current = snapshot.agents[0]!;
      await rejected(api.save({ ...specialistInput(), id: current.id, revision: current.revision, profile: current,
        assignment: { assigned: true, instructions: 'Injected hidden override' } }), 'need migration');
      await rejected(api.save({ ...specialistInput(), id: current.id, revision: current.revision,
        profile: { ...current, instructionFiles: ['/private/linked.md'] } }), 'need migration');
      expect(f.registry.snapshot(f.workspace)).toEqual(snapshot);
      await rejected(api.save({ ...specialistInput(), id: current.id, revision: current.revision,
        profile: { ...current, accountId: 'default', model: 'unsupported' } }), 'unavailable');
      expect(await readFile(join(f.repository, 'agent.json'), 'utf8')).toBe(originalManifest);
      const selection = { model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
      await api.save({ ...specialistInput(), id: current.id, revision: current.revision,
        profile: { ...current, ...selection, accountId: 'default', instructions: 'Ignored stale instructions' } });
      expect((await readHomieSource(f.repository)).pack.model).toEqual(selection);
      const changed = f.registry.snapshot(f.workspace).agents[0]!;
      expect(changed.package?.model).toEqual(selection);
      expect(changed.instructions).toBe(current.instructions);
      await api.save({ ...specialistInput(), id: changed.id, revision: changed.revision,
        profile: { ...changed, model: null, reasoningEffort: null, serviceTier: null } });
      const resolved = f.registry.snapshot(f.workspace).agents[0]!;
      expect(resolved).toMatchObject({ model: 'model-fixture', reasoningEffort: 'medium', serviceTier: null });
      expect((await readHomieSource(f.repository)).pack.model).toEqual(resolved.package!.model);
      f.registry.save({ ...specialistInput(), id: resolved.id, revision: resolved.revision, profile: resolved,
        assignment: { assigned: true, instructions: 'Existing legacy rules' } }, f.workspace);
      const legacy = f.registry.snapshot(f.workspace).agents[0]!;
      await rejected(api.save({ ...specialistInput(), id: legacy.id, revision: legacy.revision, profile: legacy }), 'need migration');
      expect(f.registry.snapshot(f.workspace).agents[0]?.assignments[0]?.instructions).toBe('Existing legacy rules');
    } finally { bridge.dispose(); }
  });
});

test('migration conflicts preserve both versions until explicitly choosing repository files', async () => {
  await fixture(async f => {
    await writeFile(join(f.repository, 'instructions.md'), 'Different repository instructions.');
    const state = await f.sources.status(f.workspace, f.agent.id);
    expect(state.phase).toBe('conflict');
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'conflicts');
    const backups = join(f.data, 'sources', 'backups'), [entry] = await readdir(backups);
    const saved = JSON.parse(await readFile(join(backups, entry!, 'saved-settings.json'), 'utf8'));
    const repository = JSON.parse(await readFile(join(backups, entry!, 'repository.json'), 'utf8'));
    expect(saved.instructions).toBe(f.agent.instructions);
    expect(repository.pack.instructions).toBe('Different repository instructions.');
    expect((await f.sources.status(f.workspace, f.agent.id, '', true)).phase).toBe('pending');
    await f.sources.prepare(f.workspace, f.agent.id);
    expect(f.registry.snapshot(f.workspace).agents[0]?.instructions).toBe('Different repository instructions.');
  });
});

test('legacy inline assets migrate into files and no account data enters the repository', async () => {
  await fixture(async f => {
    const pack = { ...f.pack, resources: { files: [{ path: 'scripts/check.ts', content: 'console.log("ok");' }], programs: [] } };
    f.registry.applySource(f.agent.id, f.agent.revision, pack);
    const { instructions: _instructions, ...manifest } = pack;
    await writeFile(join(f.repository, 'agent.json'), JSON.stringify(manifest));
    await f.sources.prepare(f.workspace, f.agent.id);
    expect(await readFile(join(f.repository, 'scripts', 'check.ts'), 'utf8')).toBe('console.log("ok");');
    const serialized = await readFile(join(f.repository, 'agent.json'), 'utf8');
    expect(JSON.parse(serialized).resources.files).toEqual(['scripts/check.ts']);
    expect(serialized).not.toContain('accountId'); expect(serialized).not.toContain(f.workspace);
    expect(sourceDigest((await readHomieSource(f.repository)).pack)).toBe(sourceDigest(pack));
  });
});

test('missing assets, invalid skills, symlinks, and package identity replacement fail before application', async () => {
  await fixture(async f => {
    await f.sources.prepare(f.workspace, f.agent.id);
    const manifest = JSON.parse(await readFile(join(f.repository, 'agent.json'), 'utf8'));
    await writeFile(join(f.repository, 'agent.json'), JSON.stringify({ ...manifest, resources: { files: ['scripts/missing.ts'], programs: [] } }));
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'missing');
    await writeFile(join(f.repository, 'agent.json'), JSON.stringify(manifest));
    await mkdir(join(f.repository, 'skills', 'broken'), { recursive: true });
    await writeFile(join(f.repository, 'skills', 'broken', 'README.md'), 'Missing skill entrypoint.');
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'SKILL.md');
    await rm(join(f.repository, 'skills'), { recursive: true });
    await mkdir(join(f.repository, 'resources'));
    await writeFile(join(f.base, 'outside.txt'), 'Private local data.');
    await createSymbolicLink(join(f.base, 'outside.txt'), join(f.repository, 'resources', 'outside.txt'));
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'symbolic');
    await rm(join(f.repository, 'resources'), { recursive: true });
    await writeFile(join(f.repository, 'agent.json'), JSON.stringify({ ...manifest, id: 'homie.replaced' }));
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'package ID');
  });
});

test('an edit made during worker preparation remains pending after the older snapshot starts', async () => {
  await fixture(async f => {
    const prepared = await f.sources.prepare(f.workspace, f.agent.id);
    await writeFile(join(f.repository, 'instructions.md'), 'New instructions saved while Docker starts.');
    await f.sources.applied(f.workspace, f.agent.id, 'docker:test', prepared.hash);
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('pending');
  });
});

test('Python caches remain on disk without changing the package or blocking worker preparation after restart', async () => {
  await fixture(async f => {
    await f.sources.prepare(f.workspace, f.agent.id);
    await mkdir(join(f.repository, 'scripts'));
    await writeFile(join(f.repository, 'scripts', 'check.py'), 'print("ready")\n');
    const original = await f.sources.prepare(f.workspace, f.agent.id);
    await f.sources.applied(f.workspace, f.agent.id, 'docker:test', original.hash);
    const cache = Buffer.from([0xf3, 0x0d, 0x0a, 0, 0xff]);
    const paths = ['scripts/__pycache__/check.cpython-314.pyc', 'scripts/check.pyc', 'scripts/check.pyo',
      'skills/example/__pycache__/nested/generated.bin', 'resources/__pycache__/resource.pyc'];
    for (const name of paths) {
      await mkdir(join(f.repository, name, '..'), { recursive: true });
      await writeFile(join(f.repository, name), cache);
    }
    expect((await readHomieSource(f.repository)).pack).toEqual(original.pack);
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('applied');
    const restarted = new HomieSources({ directory: join(f.data, 'sources'), registry: f.registry, repositories: f.repositories });
    expect(await restarted.prepare(f.workspace, f.agent.id)).toEqual(original);
    for (const name of paths) expect(await readFile(join(f.repository, name))).toEqual(cache);
  });
});

test('invalid UTF-8 source reports its relative path and still prevents worker preparation', async () => {
  await fixture(async f => {
    await f.sources.prepare(f.workspace, f.agent.id);
    await mkdir(join(f.repository, 'scripts'));
    await writeFile(join(f.repository, 'scripts', 'broken.py'), Buffer.from([0xff, 0xfe]));
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'scripts/broken.py:');
    const status = await f.sources.status(f.workspace, f.agent.id);
    expect(status.phase).toBe('invalid');
    expect(status.message).toContain('scripts/broken.py:');
    expect(status.message).toContain('UTF-8');
  });
});

test('cache names do not bypass symlink checks or satisfy explicitly declared resources', async () => {
  await fixture(async f => {
    await f.sources.prepare(f.workspace, f.agent.id);
    await mkdir(join(f.repository, 'scripts'));
    const cache = join(f.repository, 'scripts', '__pycache__');
    await createSymbolicLink(f.base, cache);
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'symbolic');
    await rm(cache);
    await writeFile(join(f.repository, 'scripts', 'check.pyc'), Buffer.from([0xff]));
    const manifest = JSON.parse(await readFile(join(f.repository, 'agent.json'), 'utf8'));
    await writeFile(join(f.repository, 'agent.json'), JSON.stringify({ ...manifest,
      resources: { files: ['scripts/check.pyc'], programs: [] } }));
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'scripts/check.pyc: declared asset is missing');
  });
});

test('project rule edits and removal invalidate applied state without migrating the repository again', async () => {
  await fixture(async f => {
    const original = await f.sources.prepare(f.workspace, f.agent.id);
    await f.sources.applied(f.workspace, f.agent.id, 'docker:test', original.hash);
    await writeFile(join(f.workspace, 'AGENTS.md'), 'Project rules from disk.');
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('pending');
    const next = await f.sources.prepare(f.workspace, f.agent.id);
    expect(next.hash).not.toBe(original.hash);
    await f.sources.applied(f.workspace, f.agent.id, 'docker:test', next.hash);
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('applied');
    await rm(join(f.workspace, 'AGENTS.md'));
    expect((await f.sources.status(f.workspace, f.agent.id, 'docker:test')).phase).toBe('pending');
  });
});

test('saved legacy overrides remain intact and source status explains the migration requirement', async () => {
  await fixture(async f => {
    f.registry.save({ ...specialistInput(), id: f.agent.id, revision: f.agent.revision, profile: f.agent,
      assignment: { assigned: true, instructions: 'Preserve these old rules.' } }, f.workspace);
    const before = f.registry.snapshot(f.workspace);
    const status = await f.sources.status(f.workspace, f.agent.id);
    expect(status.phase).toBe('invalid'); expect(status.message).toContain('need migration');
    await rejected(f.sources.prepare(f.workspace, f.agent.id), 'need migration');
    expect(f.registry.snapshot(f.workspace)).toEqual(before);
  });
});
