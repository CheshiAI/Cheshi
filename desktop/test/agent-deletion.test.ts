import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deletionFixture } from './agent-deletion-fixtures';
import { createAgentDeletion } from '../lib/agent-management/deletion.mts';
import { workerOperations } from '../lib/agent-management/operations.mts';
import { createSpecialistRuntime } from '../lib/agent-management/runtime.mts';
import { createAgentManagementService } from '../lib/agent-management/service.mts';
import { specialistInput, registryDeferred } from './agent-registry-fixtures';
import { parseDeleteContainer } from '../shared/agent-management';
import { parseDeleteSpecialistAgent } from '../shared/agent-registry';
import { createDockerAgentEngine } from '../lib/agent-management/docker.mts';
import { AgentManagementModel } from '../frontend/src/shared/agent-management/agentManagementModel';
import { parseAgentSnapshot } from '../shared/agent-management';

async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
test('container deletion stops an idle owned worker and retains registry, data and images by default', async () => {
  const f = deletionFixture();
  try {
    await f.deletion.container(f.request());
    expect(f.containers.size).toBe(0); expect(f.volumes.has(f.volume)).toBe(true);
    expect(f.registry.snapshot(f.workspace).agents).toEqual([f.profile]);
    expect(f.calls.filter(args => args[3] === 'stop')).toHaveLength(1);
    expect(f.calls.filter(args => args[3] === 'rm')).toEqual([['--host', 'unix:///tmp/local.sock', 'container', 'rm', f.containerId]]);
    expect(f.calls.flat()).not.toContain('--force'); expect(f.calls.flat()).not.toContain('image');
  } finally { f.close(); }
});
test('agent deletion removes every assignment and owned storage only after all workers are cleaned', async () => {
  const f = deletionFixture();
  try {
    const saved = f.registry.save({ ...specialistInput(), id: f.profile.id, revision: 1 }, '/projects/second').snapshot.agents[0]!;
    const other = f.registry.save({ ...specialistInput(), profile: { ...specialistInput().profile, name: 'Other' } }, f.workspace).snapshot.agents.find(agent => agent.id !== saved.id)!;
    const second = structuredClone(f.worker);
    second.Id = 'b'.repeat(64); second.Config.Labels['ai.cheshi.binding'] = `${f.profile.id}-${'d'.repeat(16)}`;
    second.Mounts[0]!.Name = `cheshi-agent-${second.Config.Labels['ai.cheshi.binding']}-${'c'.repeat(8)}`;
    f.containers.set(second.Id, second); f.volumes.add(second.Mounts[0]!.Name!);
    const unrelated = structuredClone(f.worker);
    unrelated.Id = 'c'.repeat(64); unrelated.Config.Labels['ai.cheshi.agent'] = other.id;
    f.containers.set(unrelated.Id, unrelated);
    // This unrelated worker uses its own storage, not the target profile's data.
    unrelated.Mounts[0]!.Name = 'unrelated-volume';
    const detached = `cheshi-agent-${f.profile.id}-${'e'.repeat(16)}-${'f'.repeat(8)}`;
    f.volumes.add(detached); f.volumes.add('unrelated-volume');
    const config = join(f.runtimePath, 'runtime.json');
    mkdirSync(join(config, '..'), { recursive: true }); writeFileSync(config, '{}');
    const result = await f.deletion.agent(f.workspace, { ...f.agentRequest(true), revision: saved.revision });
    expect(result.agents).toEqual([other]); expect([...f.containers.keys()]).toEqual([unrelated.Id]);
    expect([...f.volumes]).toEqual(['unrelated-volume']); expect(existsSync(config)).toBe(false);
  } finally { f.close(); }
});
test('global deletion supersedes a failed container cleanup and preserves data when newly requested', async () => {
  const f = deletionFixture();
  try {
    f.state.failVolume = true;
    await fails(f.deletion.container(f.request(true)), 'volume removal failed');
    await f.deletion.agent(f.workspace, f.agentRequest(false));
    expect(f.volumes.has(f.volume)).toBe(true);
    expect(f.registry.snapshot(f.workspace).agents).toHaveLength(0);
    expect(await f.deletion.pending('docker:local')).toEqual([]);
  } finally { f.close(); }
});
test('busy, unknown or invalid worker activity, shared data and remote engines fail before deletion', async () => {
  for (const [flag, message] of [['busy', 'active'], ['unknown', 'unconfirmed'], ['malformedHealth', 'flag'],
    ['shared', 'shared'], ['nonstandardVolume', 'nonstandard'], ['remote', 'local Docker']] as const) {
    const f = deletionFixture();
    try {
      f.state[flag] = true;
      await fails(f.deletion.container(f.request(true)), message);
      expect(f.calls.some(args => ['stop', 'rm'].includes(args[3] ?? ''))).toBe(false);
      expect(f.registry.snapshot(f.workspace).agents).toEqual([f.profile]);
    } finally { f.close(); }
  }
});
test('global deletion preflights previously used engines and refuses stale profiles or changed ownership', async () => {
  const f = deletionFixture();
  try {
    f.engines.push({ id: 'docker:offline', name: 'offline', supported: true, reason: null }); f.state.offline = 'offline';
    const offlinePath = f.rememberEngine('docker:offline', 'unix:///tmp/offline.sock');
    await fails(f.deletion.agent(f.workspace, f.agentRequest()), 'offline');
    expect(f.containers.size).toBe(1); expect(f.calls.some(args => args[3] === 'stop')).toBe(false);
    f.engines.pop(); f.state.offline = ''; rmSync(offlinePath, { recursive: true });
    await fails(f.deletion.agent(f.workspace, { ...f.agentRequest(), revision: 2 }), 'changed');
    f.worker.Config.Labels['ai.cheshi.worker'] = 'unrelated';
    await fails(f.deletion.container(f.request()), 'not a managed');
  } finally { f.close(); }
});
test('partial container deletion can retry volume cleanup after service restart', async () => {
  const f = deletionFixture();
  try {
    f.state.failVolume = true;
    await fails(f.deletion.container(f.request(true)), 'volume removal failed');
    expect(f.containers.size).toBe(0); expect(f.volumes.has(f.volume)).toBe(true);
    expect(readdirSync(f.options.directory)).toHaveLength(1);
    expect(await createAgentDeletion(f.options).pending('docker:local')).toEqual([f.request(true)]);
    expect(await f.deletion.pending('docker:other')).toEqual([]);
    await fails(f.deletion.container(f.request(false)), 'same saved-data option');
    f.state.failVolume = false;
    await createAgentDeletion(f.options).container(f.request(true));
    expect(f.volumes.size).toBe(0); expect(readdirSync(f.options.directory)).toHaveLength(0);
    expect(await f.deletion.pending('docker:local')).toEqual([]);
    expect(f.registry.snapshot(f.workspace).agents).toEqual([f.profile]);
  } finally { f.close(); }
});
test('failed global cleanup retains registration and resumes without restoring removed containers', async () => {
  const f = deletionFixture();
  try {
    f.state.failVolume = true;
    await fails(f.deletion.agent(f.workspace, f.agentRequest(true)), 'volume removal failed');
    expect(f.registry.snapshot(f.workspace).agents).toEqual([f.profile]);
    f.state.failVolume = false;
    expect((await createAgentDeletion(f.options).agent(f.workspace, f.agentRequest(true))).agents).toHaveLength(0);
    expect(f.calls.filter(args => args[2] === 'container' && args[3] === 'rm')).toHaveLength(1);
  } finally { f.close(); }
});
test('unfinished container cleanup is selectable after reopening and does not inspect the missing container', async () => {
  const f = deletionFixture();
  let model: AgentManagementModel | undefined;
  try {
    f.state.failVolume = true;
    await fails(f.deletion.container(f.request(true)), 'volume removal failed');
    const reopened = createAgentDeletion(f.options);
    const service = createAgentManagementService({ engines: [createDockerAgentEngine(f.run)], pendingDeletions: engine => reopened.pending(engine) });
    const snapshot = parseAgentSnapshot(await service.snapshot('docker:local'));
    expect(snapshot.agents[0]).toMatchObject({ id: f.containerId, state: 'cleanup-pending', pendingDeletion: { deleteData: true } });
    let inspections = 0;
    model = new AgentManagementModel({ ...service, engines: f.options.management.engines,
      details: async () => { inspections++; throw new Error('Missing container must not be inspected'); }, remove: request => reopened.container(request) });
    await model.discover();
    expect(model.snapshot().agentId).toBe(f.containerId); expect(inspections).toBe(0);
    f.state.failVolume = false;
    await model.remove('docker:local', f.containerId, true);
    expect(model.snapshot().snapshot?.agents).toEqual([]); expect(model.snapshot().agentId).toBe('');
  } finally { model?.dispose(); f.close(); }
});
test('deletion and normal mutations exclude one another across services and release after failure', async () => {
  const f = deletionFixture();
  try {
    const gate = registryDeferred<void>();
    const operation = workerOperations.run(() => gate.promise);
    await fails(f.deletion.container(f.request()), 'operation is in progress');
    gate.resolve(); await operation;
    const management = createAgentManagementService({ engines: [] });
    const runtime = createSpecialistRuntime({ ...f.options, buildContext: '/unused', management,
      account: async () => { throw new Error('must not request an account'); } });
    await workerOperations.exclusive(async () => {
      expect(() => f.registry.save(specialistInput(), f.workspace)).toThrow('deletion is in progress');
      await fails(management.control('docker:local', f.containerId, 'start'), 'deletion is in progress');
      await fails(runtime.request(f.workspace, { agentId: f.profile.id, engineId: 'docker:local', action: 'start' }), 'deletion is in progress');
      await fails(f.deletion.container(f.request()), 'deletion is in progress');
    });
    f.state.failRemove = true;
    await fails(f.deletion.container(f.request()), 'remove failed');
    expect(f.registry.snapshot(f.workspace).agents).toHaveLength(1);
    f.state.failRemove = false; await f.deletion.container(f.request());
  } finally { f.close(); }
});
test('deletion contracts require exact identities, revisions and literal data deletion choices', () => {
  const id = 'a1234567-1234-1234-1234-123456789abc';
  for (const deleteData of [undefined, null, 'true', 1]) {
    expect(() => parseDeleteContainer({ engineId: 'docker:local', containerId: 'a'.repeat(64), deleteData })).toThrow();
    expect(() => parseDeleteSpecialistAgent({ id, revision: 1, deleteData })).toThrow();
  }
  expect(() => parseDeleteContainer({ engineId: 'docker:local', containerId: 'worker', deleteData: false })).toThrow();
  expect(() => parseDeleteSpecialistAgent({ id, revision: 0, deleteData: false })).toThrow();
});

test('unused inactive engines do not block legacy worker deletion or data cleanup', async () => {
  const f = deletionFixture();
  try {
    f.engines.push({ id: 'docker:offline', name: 'offline', supported: true, reason: null });
    f.state.offline = 'offline';
    await f.deletion.agent(f.workspace, f.agentRequest(true));
    expect(f.registry.snapshot(f.workspace).agents).toEqual([]);
    expect(f.containers.size).toBe(0); expect(f.volumes.size).toBe(0);
    expect(f.calls.flat().some(arg => arg.includes('offline'))).toBe(false);
  } finally { f.close(); }
});
test('saved engine history remains authoritative when discovery omits a used engine', async () => {
  const f = deletionFixture();
  try {
    f.rememberEngine('docker:local', 'unix:///tmp/local.sock');
    f.engines.splice(0); f.state.offline = 'local';
    await fails(f.deletion.agent(f.workspace, f.agentRequest(true)), 'previously used worker engine docker:local');
    expect(f.containers.size).toBe(1); expect(f.registry.snapshot(f.workspace).agents).toEqual([f.profile]);
    f.state.offline = '';
    await createAgentDeletion(f.options).agent(f.workspace, f.agentRequest(true));
    expect(f.containers.size).toBe(0); expect(f.volumes.size).toBe(0);
    expect(existsSync(f.runtimePath)).toBe(false);
  } finally { f.close(); }
});
test('unresolved legacy engines and changed saved socket addresses block deletion before mutation', async () => {
  const f = deletionFixture();
  try {
    f.engines.splice(0);
    await fails(f.deletion.agent(f.workspace, f.agentRequest(true)), 'Cannot identify');
    f.rememberEngine('docker:local', 'unix:///tmp/original.sock');
    await fails(f.deletion.agent(f.workspace, f.agentRequest(true)), 'original connection');
    expect(f.calls.some(args => ['stop', 'rm'].includes(args[3] ?? ''))).toBe(false);
    expect(f.registry.snapshot(f.workspace).agents).toEqual([f.profile]);
  } finally { f.close(); }
});
test('a profile that never provisioned a worker can be deleted with inactive engines', async () => {
  const f = deletionFixture();
  try {
    rmSync(f.runtimePath, { recursive: true });
    f.containers.clear(); f.volumes.clear(); f.state.offline = 'local';
    await f.deletion.agent(f.workspace, f.agentRequest(true));
    expect(f.registry.snapshot(f.workspace).agents).toEqual([]);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test('unfinished container cleanup supplies engine ownership after runtime settings disappear', async () => {
  const f = deletionFixture();
  try {
    f.state.failVolume = true;
    await fails(f.deletion.container(f.request(true)), 'volume removal failed');
    rmSync(f.runtimePath, { recursive: true });
    f.engines.splice(0); f.state.failVolume = false;
    await createAgentDeletion(f.options).agent(f.workspace, f.agentRequest(true));
    expect(f.registry.snapshot(f.workspace).agents).toEqual([]);
    expect(f.volumes.size).toBe(0);
    expect(await f.deletion.pending('docker:local')).toEqual([]);
  } finally { f.close(); }
});
