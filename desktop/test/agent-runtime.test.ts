import { createHash } from 'node:crypto';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecialistRuntime, readRuntimeAuth } from '../lib/agent-management/runtime.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { registryDeferred, specialistInput } from './agent-registry-fixtures.ts';
import { parseAgentRuntimeRequest, parseAgentRuntimeState } from '../shared/agent-runtime.ts';
import { DockerCommandError, dockerCommandError } from '../lib/agent-management/docker-errors.mts';
import type { AgentDetails } from '../shared/agent-management.ts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
function fixture(linkedWorkspace = false, prepareCodeGraph?: (workspace: string) => Promise<void>, withCodeGraph = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-runtime-')); directories.push(directory);
  const project = join(directory, 'project'), home = join(directory, 'account');
  mkdirSync(project); mkdirSync(home);
  const workspace = linkedWorkspace ? join(directory, 'project-link') : project;
  if (linkedWorkspace) createSymbolicLink(project, workspace);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id', account_id: 'fixture-account' }, secret_extra: 'exclude' }));
  const registry = createAgentRegistry(join(directory, 'registry.json'));
  const input = specialistInput(); input.profile.accountId = 'default';
  const agentId = registry.save(input, workspace).agentId;
  let projectDocMaxBytes = 32768;
  let created = false, remote = false, busy = false, seeded = false, failSeed = false;
  let dockerFailure: Error | null = null, contextMissing = false;
  let labels: Record<string, string> = {};
  let tasks: AgentDetails['tasks'] = [];
  let state = 'running';
  let beforeDetails: (() => Promise<void>) | undefined;
  const calls: { args: string[]; input?: string }[] = [];
  const runtimePath = join(directory, 'runtime', createHash('sha256').update('docker:colima-cheshi').digest('hex'),
    `${agentId}-${createHash('sha256').update(realpathSync(workspace)).digest('hex').slice(0, 16)}`);
  const id = 'a'.repeat(64);
  const run: DockerCommand = async (args, input) => {
    calls.push({ args, input });
    if (dockerFailure) throw dockerFailure;
    if (args[0] === 'context' && contextMissing) throw dockerCommandError(Object.assign(new Error(), { code: 1 }),
      'context "colima-cheshi": context not found: open /fixture/contexts/meta/id/meta.json: no such file or directory', args);
    if (args.includes('exec')) {
      if (args.at(-1)?.includes('createHash')) return seeded ? createHash('sha256').update('fixture-account').digest('hex') : '';
      if (!input) return seeded ? 'configured' : 'pending';
      if (failSeed) { failSeed = false; throw new Error('bootstrap interrupted'); }
      seeded = true; return '';
    }
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: remote ? 'ssh://other' : 'unix:///tmp/docker.sock' } } }]);
    if (args.includes('info')) return 'linux/arm64';
    if (args.includes('image') && args.includes('inspect')) return 'sha256:environment';
    if (args.includes('image') && args.includes('ls')) return 'cached-dependencies';
    if (args.includes('ls')) return created ? id : '';
    if (args.includes('inspect')) return JSON.stringify([{ Id: id, ExecIDs: null, Name: '/worker', Config: { Image: 'worker', Labels: labels },
      State: { Status: state }, NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '49831' }] } } }]);
    if (args.includes('create')) {
      expect(JSON.parse(readFileSync(join(runtimePath, 'engine.json'), 'utf8'))).toEqual({
        engineId: 'docker:colima-cheshi', host: 'unix:///tmp/docker.sock',
      });
      created = true; labels = {};
      args.forEach((arg, index) => { if (arg === '--label') { const [key, value] = args[index + 1]!.split('='); labels[key!] = value!; } });
      return id;
    }
    if (args.includes('rm')) created = false;
    return '';
  };
  const details = (): AgentDetails => ({ agent: { id, name: 'worker', image: 'worker', state },
    ready: seeded, busy, authenticated: true, threadId: null, error: null, logs: '', tasks });
  const exchanges: unknown[] = [];
  const runtime = createSpecialistRuntime({ prepareCodeGraph, getProjectDocMaxBytes: () => projectDocMaxBytes, directory: join(directory, 'runtime'), buildContext: '/build', registry, run, checkProjectEnvironment: async () => {},
    codegraph: withCodeGraph ? async () => ({ result: 'fixture' }) : undefined,
    lifecycleControl: async () => ({ protocol: 1, idle: false, nextWakeAt: null }),
    collaborationExchange: async (_connection, body) => { exchanges.push(body); return { protocol: 1, received: [], outgoing: [] }; },
    account: async () => ({ home, models: [] }), management: { details: async () => { await beforeDetails?.(); return details(); },
      engines: async () => ({ engines: [], error: null }), snapshot: async engineId => ({ engineId, online: true, error: null, agents: [] }),
      control: async () => { throw new Error('unused'); } } });
  const legacyRecovery = (protocol = 1, progress = false, work = false, integration = false, candidate = false, application = false, applicationInspection = false, conversation = false, activity = false) => {
    const filename = join(runtimePath, 'runtime.json');
    const config = JSON.parse(readFileSync(filename, 'utf8'));
    const agent = registry.snapshot(workspace).agents[0]!;
    const assignment = agent.assignments.find(a => a.workspaceRoot === workspace)!;
    const profile = { role: agent.role, accountId: agent.accountId, model: agent.model, reasoningEffort: agent.reasoningEffort,
      serviceTier: agent.serviceTier, permissions: agent.permissions, instructions: agent.instructions };
    config.recoveryProtocol = protocol; delete config.inputQueueProtocol; delete config.activityProtocol; delete config.conversationProtocol; delete config.progressProtocol; delete config.workProtocol; delete config.integrationProtocol; delete config.candidateVerificationProtocol; delete config.applicationProtocol; delete config.applicationInspectionProtocol;
    if (activity) config.activityProtocol = 1;
    if (conversation) config.conversationProtocol = 1;
    if (progress) config.progressProtocol = 1;
    if (work) config.workProtocol = 1;
    if (integration) config.integrationProtocol = 1;
    if (candidate) config.candidateVerificationProtocol = 1;
    if (application) config.applicationProtocol = 1;
    if (applicationInspection) config.applicationInspectionProtocol = 1;
    config.settingsFingerprint = createHash('sha256').update(JSON.stringify({ ...(activity ? { activityProtocol: 1 } : {}), ...(conversation ? { conversationProtocol: 1, lifecycleProtocol: 1, eventsProtocol: 1 } : {}), sandboxProtocol: 2, collaborationProtocol: 1,
      decisionProtocol: 1, verificationProtocol: 1, chatsProtocol: 1, recoveryProtocol: protocol, questionProtocol: 2, ...(progress ? { progressProtocol: 1 } : {}),
      ...(work ? { workProtocol: 1 } : {}), ...(integration ? { integrationProtocol: 1 } : {}), ...(candidate ? { candidateVerificationProtocol: 1 } : {}), ...(application ? { applicationProtocol: 1 } : {}), ...(applicationInspection ? { applicationInspectionProtocol: 1 } : {}), agent: profile, workspace: realpathSync(workspace), instructions: assignment.instructions })).digest('hex');
    config.revision = config.settingsFingerprint;
    labels['ai.cheshi.configuration'] = config.revision;
    writeFileSync(filename, JSON.stringify(config));
  };
  const previousInstructionLimit = () => {
    const filename = join(runtimePath, 'runtime.json');
    const config = JSON.parse(readFileSync(filename, 'utf8'));
    const agent = registry.snapshot(workspace).agents[0]!;
    const assignment = agent.assignments.find(a => a.workspaceRoot === workspace)!;
    // Historical fingerprint before project_doc_max_bytes was included; no dependency plan in this fixture.
    const settings = { inputQueueProtocol: 1, activityProtocol: 1, conversationProtocol: 1, lifecycleProtocol: 1, eventsProtocol: 1,
      sandboxProtocol: 3, permissionProtocol: 1, collaborationProtocol: 1, decisionProtocol: 1, verificationProtocol: 1,
      chatsProtocol: 1, recoveryProtocol: 3, questionProtocol: 2, progressProtocol: 1, workProtocol: 1, integrationProtocol: 1,
      candidateVerificationProtocol: 1, applicationProtocol: 1, applicationInspectionProtocol: 1,
      agent: { role: agent.role, accountId: agent.accountId, model: agent.model, reasoningEffort: agent.reasoningEffort,
        serviceTier: agent.serviceTier, permissions: agent.permissions, instructions: agent.instructions },
      workspace: realpathSync(workspace), instructions: assignment.instructions };
    const previous = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
    config.settingsFingerprint = createHash('sha256').update(`${previous}\n`).digest('hex');
    config.revision = config.settingsFingerprint;
    labels['ai.cheshi.configuration'] = config.revision;
    writeFileSync(filename, JSON.stringify(config));
  };
  const legacyHistory = () => {
    const filename = join(runtimePath, 'runtime.json');
    const previous = JSON.parse(readFileSync(filename, 'utf8'));
    const fingerprint = createHash('sha256').update(`retired-history:${previous.settingsFingerprint}`).digest('hex');
    labels['ai.cheshi.configuration'] = fingerprint;
    writeFileSync(filename, JSON.stringify({ ...previous, historyProtocol: 1, settingsFingerprint: fingerprint, revision: fingerprint }));
  };
  return { runtime, registry, workspace, home, runtimePath, agentId, calls, exchanges, legacyRecovery, previousInstructionLimit, legacyHistory,
    setProjectDocMaxBytes: (value: number) => { projectDocMaxBytes = value; },
    onDetails: (callback: () => Promise<void>) => { beforeDetails = callback; },
    setState: (value: string) => { state = value; },
    setTasks: (value: AgentDetails['tasks']) => { tasks = value; }, setContextMissing: (missing: boolean) => { contextMissing = missing; }, setDockerFailure: (error: Error | null) => { dockerFailure = error; }, failBootstrap: () => { failSeed = true; }, setBusy: () => { busy = true; }, setRemote: () => { remote = true; },
    request: () => ({ agentId, engineId: 'docker:colima-cheshi', action: 'start' as const }) };
}
test('required package tools are checked before Docker operations', async () => {
  const f = fixture();
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  const [definition] = await officialAgentPackages();
  f.registry.save({ id: agent.id, revision: agent.revision, profile: { ...agent, package: definition },
    assignment: { assigned: true, instructions: '' } }, f.workspace);
  await fails(f.runtime.request(f.workspace, f.request()), 'requires CodeGraph');
  expect(f.calls).toEqual([]);
});

test('package instructions reach the worker and updates wait for explicit Start', async () => {
  const f = fixture(false, undefined, true);
  let agent = f.registry.snapshot(f.workspace).agents[0]!;
  const [definition] = await officialAgentPackages();
  agent = f.registry.save({ id: agent.id, revision: agent.revision,
    profile: { ...agent, instructions: definition!.instructions, package: definition },
    assignment: { assigned: true, instructions: 'Local project rules.' } }, f.workspace).snapshot.agents[0]!;
  try {
    await f.runtime.request(f.workspace, f.request());
    const configured = () => JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8'));
    expect(configured().instructions).toBe(`${definition!.instructions}\n\nProject instructions:\nLocal project rules.`);
    expect(configured().codegraphProtocol).toBe(1);
    f.registry.save({ id: agent.id, revision: agent.revision,
      profile: { ...agent, instructions: 'Updated package instructions', package: { ...definition!, version: '1.1.0', instructions: 'Updated package instructions' } },
      assignment: { assigned: true, instructions: 'Local project rules.' } }, f.workspace);
    expect(configured().instructions).toContain(definition!.instructions);
    await f.runtime.request(f.workspace, f.request());
    expect(configured().instructions).toBe('Updated package instructions\n\nProject instructions:\nLocal project rules.');
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(2);
  } finally { f.runtime.dispose(); }
});

test('pack resources reach the worker image and changed assets require Start without rebuilding during status', async () => {
  const f = fixture(false, undefined, true);
  let agent = f.registry.snapshot(f.workspace).agents[0]!;
  const definition = { ...(await officialAgentPackages())[0]!, resources: { files: [{ path: 'scripts/check.ts', content: 'console.log(1)' }], programs: ['jq'] } };
  agent = f.registry.save({ id: agent.id, revision: agent.revision, profile: { ...agent, package: definition },
    assignment: { assigned: true, instructions: '' } }, f.workspace).snapshot.agents[0]!;
  try {
    await f.runtime.request(f.workspace, f.request());
    const created = f.calls.find(call => call.args.includes('create'))!;
    expect(created.args.at(-1)).toStartWith('cheshi-homie-pack:');
    const configuration = JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8'));
    expect(configuration.instructions).toContain('/opt/cheshi/homie-pack/scripts/check.ts');
    expect(configuration.homiePack.resources).toEqual(definition.resources);
    f.calls.length = 0;
    await f.runtime.request(f.workspace, { ...f.request(), action: 'status' });
    expect(f.calls.some(call => call.args.includes('build') || call.args.includes('create'))).toBe(false);
    f.registry.save({ id: agent.id, revision: agent.revision,
      profile: { ...agent, package: { ...definition, resources: { ...definition.resources, files: [{ path: 'scripts/check.ts', content: 'console.log(2)' }] } } },
      assignment: { assigned: true, instructions: '' } }, f.workspace);
    const status = await f.runtime.request(f.workspace, { ...f.request(), action: 'status' });
    expect(status.details?.error).toContain('Settings changed');
    expect(f.calls.some(call => call.args.includes('build'))).toBe(false);
    await f.runtime.request(f.workspace, f.request());
    expect(f.calls.find(call => call.args.includes('create'))!.args.at(-1)).not.toBe(created.args.at(-1));
  } finally { f.runtime.dispose(); }
});

test('command-enabled worker uses separate dependency volumes and unchanged starts and status do not rebuild', async () => {
  const f = fixture();
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  f.registry.save({ id: agent.id, revision: agent.revision,
    profile: { ...agent, permissions: { fileWrite: true, commandExecution: true } },
    assignment: { assigned: true, instructions: '' } }, f.workspace);
  writeFileSync(join(f.workspace, 'package.json'), '{}'); writeFileSync(join(f.workspace, 'bun.lock'), '{}');
  try {
    await f.runtime.request(f.workspace, f.request());
    const builds = f.calls.filter(c => c.args.includes('build'));
    expect(builds).toHaveLength(2);
    expect(builds[0]!.args).toContain('specialist-environment');
    const create = f.calls.find(c => c.args.includes('create'))!.args;
    expect(create.at(-1)).toBe('cheshi-specialist:1');
    expect(create.some(a => a.startsWith('type=volume,src=cheshi-deps-'))).toBe(true);
    const start = f.calls.length;
    await f.runtime.request(f.workspace, { ...f.request(), action: 'status' });
    await f.runtime.request(f.workspace, f.request());
    expect(f.calls.slice(start).some(c => c.args.includes('build') || c.args.includes('run'))).toBe(false);
  } finally { await f.runtime.dispose(); }
});
test('manual control preserves the latest runtime task list while status reports confirmed stop', async () => {
  const f = fixture();
  try {
    const started = await f.runtime.request(f.workspace, f.request());
    const tasks = [{ id: 'latest', status: 'completed', prompt: 'Check', output: 'Latest result', error: null, createdAt: '2026-10-04' }];
    f.setTasks(tasks);
    await f.runtime.manualControl(f.request().engineId, started.details!.agent.id, 'stop', async () => { f.setState('exited'); });
    f.setTasks([]); // The stopped HTTP API cannot return activity anymore.
    const status = parseAgentRuntimeState(await f.runtime.request(f.workspace, { ...f.request(), action: 'status' }));
    expect(status).toMatchObject({ lifecycle: { phase: 'disabled' }, details: { ready: false, busy: false,
      agent: { state: 'exited' }, tasks } });
    await fails(f.runtime.wake(f.workspace, { ...f.request(), action: 'status' }), 'manually stopped');
  } finally { await f.runtime.dispose(); }
});
test('missing selected context returns offline on repeated polls and restoration resumes normal lookup', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    const status = { ...f.request(), action: 'status' as const };
    f.setContextMissing(true);
    for (let index = 0; index < 3; index++) {
      const result = parseAgentRuntimeState(await f.runtime.request(f.workspace, status));
      expect(result.details).toBeNull(); expect(result.unavailable?.kind).toBe('engine-unavailable');
    }
    await fails(f.runtime.request(f.workspace, f.request()), 'disconnected');
    f.setContextMissing(false);
    const restored = await f.runtime.request(f.workspace, status);
    expect(restored.unavailable).toBeUndefined(); expect(restored.details?.ready).toBe(true);
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
  } finally { await f.runtime.dispose(); }
});
test('status returns a disconnected state and recovers, while mutations and other failures still reject', async () => {
  const f = fixture();
  await f.runtime.request(f.workspace, f.request());
  const status = { ...f.request(), action: 'status' as const };
  f.setDockerFailure(new DockerCommandError('engine-unavailable', 'Engine disconnected'));
  expect(parseAgentRuntimeState(await f.runtime.request(f.workspace, status))).toEqual({
    details: null, unavailable: { kind: 'engine-unavailable', message: 'Engine disconnected' },
  });
  await fails(f.runtime.request(f.workspace, f.request()), 'Engine disconnected');
  for (const kind of ['cli-missing', 'permission-denied', 'timeout', 'command-failed'] as const) {
    f.setDockerFailure(new DockerCommandError(kind, kind));
    await fails(f.runtime.request(f.workspace, status), kind);
  }
  f.setDockerFailure(null);
  expect((await f.runtime.request(f.workspace, status)).details?.ready).toBe(true);
  expect((await f.runtime.request(f.workspace, f.request())).details?.ready).toBe(true);
  expect(() => parseAgentRuntimeState({ details: null, unavailable: { kind: 'unexpected', message: 'bad' } })).toThrow('availability');
  await f.runtime.dispose();
});
test('starts one project worker with isolated storage, readonly mount, private auth input and persisted settings', async () => {
  const f = fixture();
  expect((await f.runtime.request(f.workspace, f.request())).details?.ready).toBe(true);
  const args = f.calls.find(call => call.args.includes('create'))!.args;
  expect(args).toContain(`type=bind,src=${realpathSync(f.workspace)},dst=/workspace,readonly`);
  expect(args).toContain('no-new-privileges:true'); expect(args).toContain('apparmor=cheshi-codex-bwrap');
  const config = JSON.parse(f.calls.find(call => call.input)!.input!).configuration;
  expect(args.some(arg => arg.includes('runtime.json,readonly'))).toBe(false);
  expect(config.decisionProtocol).toBe(1);
  expect(config.recoveryProtocol).toBe(3);
  expect(config.verificationProtocol).toBe(1); expect(config.candidateVerificationProtocol).toBe(1); expect(config.applicationProtocol).toBe(1);
  expect(config.permissions).toEqual({ fileWrite: false, commandExecution: false });
  expect(config.instructions).toContain('Project instructions:');
  expect(config).not.toHaveProperty('tokens');
  expect(f.calls.map(call => call.args.join(' ')).join('\n')).not.toContain('fixture-access');
  expect(f.calls.find(call => call.input)?.input).toContain('fixture-access');
  expect(f.calls.find(call => call.input)?.input).not.toContain('secret_extra');
  await f.runtime.request(f.workspace, f.request());
  expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
});
test('rejects unassigned profiles and remote engines before provisioning', async () => {
  const f = fixture();
  f.setRemote(); await fails(f.runtime.request(f.workspace, f.request()), 'Only local');
  expect(f.calls.some(call => call.args.includes('create'))).toBe(false);
  await fails(f.runtime.request(f.home, f.request()), 'Assign this agent');
});

test('a worker without an explicit instruction limit is replaced on start while its conversation volume is preserved', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    f.previousInstructionLimit();
    const status = await f.runtime.request(f.workspace, { ...f.request(), action: 'status' });
    expect(status.details?.error).toContain('Settings changed');
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
    await f.runtime.request(f.workspace, f.request());
    const created = f.calls.filter(call => call.args.includes('create'));
    expect(created).toHaveLength(2);
    const volume = (args: string[]) => args.find(arg => arg.startsWith('type=volume,src=cheshi-agent-'));
    expect(volume(created[1]!.args)).toBe(volume(created[0]!.args));
    expect(f.calls.some(call => call.args.includes('volume') && call.args.includes('rm'))).toBe(false);
  } finally { await f.runtime.dispose(); }
});

function assignFixture(f: ReturnType<typeof fixture>, assigned: boolean) {
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  f.registry.save({ id: agent.id, revision: agent.revision, profile: agent,
    assignment: { assigned, instructions: specialistInput().assignment.instructions } }, f.workspace);
}

test('unassigned and deleted status is explicit without Docker access, while execution remains blocked', async () => {
  const f = fixture(), status = { ...f.request(), action: 'status' as const };
  try {
    assignFixture(f, false);
    expect(parseAgentRuntimeState(await f.runtime.request(f.workspace, status))).toMatchObject({
      details: null, unavailable: { kind: 'agent-unassigned' },
    });
    await fails(f.runtime.request(f.workspace, f.request()), 'Assign this agent');
    await fails(f.runtime.request(f.workspace, { ...status, action: 'submit', taskId: 'task', prompt: 'Work' }), 'Assign this agent');
    await fails(f.runtime.wake(f.workspace, status), 'Assign this agent');
    expect(f.calls).toHaveLength(0);
    assignFixture(f, true);
    expect((await f.runtime.request(f.workspace, f.request())).details?.ready).toBe(true);
    const agent = f.registry.snapshot(f.workspace).agents[0]!;
    f.registry.remove({ id: agent.id, revision: agent.revision, deleteData: false }, f.workspace);
    const count = f.calls.length;
    expect(parseAgentRuntimeState(await f.runtime.request(f.workspace, status))).toMatchObject({
      details: null, unavailable: { kind: 'agent-removed' },
    });
    await fails(f.runtime.request(f.workspace, f.request()), 'Assign this agent');
    expect(f.calls).toHaveLength(count);
  } finally { await f.runtime.dispose(); }
});

test.each([['unassign', false], ['delete', false], ['unassign', true], ['delete', true]] as const)(
  'status discards in-flight results after %s, failed lookup: %s', async (change, failed) => {
  const f = fixture(), entered = registryDeferred<void>(), released = registryDeferred<void>();
  try {
    await f.runtime.request(f.workspace, f.request());
    f.onDetails(async () => { entered.resolve(); await released.promise; if (failed) throw new Error('Worker disappeared'); });
    const pendingStatus = f.runtime.request(f.workspace, { ...f.request(), action: 'status' });
    await entered.promise;
    if (change === 'unassign') assignFixture(f, false);
    else {
      const agent = f.registry.snapshot(f.workspace).agents[0]!;
      f.registry.remove({ id: agent.id, revision: agent.revision, deleteData: false }, f.workspace);
    }
    released.resolve();
    expect(parseAgentRuntimeState(await pendingStatus)).toMatchObject({ details: null,
      unavailable: { kind: change === 'unassign' ? 'agent-unassigned' : 'agent-removed' } });
  } finally { released.resolve(); await f.runtime.dispose(); }
});

test('unassignment hides a stopped worker cache and reassignment restores status', async () => {
  const f = fixture(), status = { ...f.request(), action: 'status' as const };
  try {
    const started = await f.runtime.request(f.workspace, f.request());
    await f.runtime.manualControl(status.engineId, started.details!.agent.id, 'stop', async () => { f.setState('exited'); });
    assignFixture(f, false);
    expect((await f.runtime.request(f.workspace, status)).unavailable?.kind).toBe('agent-unassigned');
    assignFixture(f, true);
    const restored = await f.runtime.request(f.workspace, status);
    expect(restored.unavailable).toBeUndefined(); expect(restored.details?.agent.state).toBe('exited');
    expect(() => parseAgentRuntimeState({ details: started.details,
      unavailable: { kind: 'agent-unassigned', message: 'Not assigned' } })).toThrow('availability');
  } finally { await f.runtime.dispose(); }
});

test('collaboration resolves a project registered through a symbolic link', async () => {
  const f = fixture(true);
  await f.runtime.request(f.workspace, f.request());
  expect(f.exchanges).toHaveLength(1);
  expect(f.exchanges[0]).toMatchObject({ peers: [{ id: f.agentId }] });
  expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.error).toBeNull();
  await f.runtime.dispose();
});
test('changed settings cannot replace a busy worker or accidentally submit under old permissions', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  f.registry.save({ id: agent.id, revision: agent.revision, profile: { ...agent, permissions: { fileWrite: true, commandExecution: true } }, assignment: { assigned: true, instructions: '' } }, f.workspace);
  f.setBusy();
  await fails(f.runtime.request(f.workspace, f.request()), 'Wait for this worker');
  await fails(f.runtime.request(f.workspace, { ...f.request(), action: 'submit', taskId: 'task', prompt: 'work' }), 'Settings changed');
  expect(f.calls.some(call => call.args.includes('rm'))).toBe(false);
});
test('validates task identities and rejects incomplete credential files without exposing their contents', async () => {
  const f = fixture();
  expect(() => parseAgentRuntimeRequest({ ...f.request(), action: 'cancel', taskId: '../escape' })).toThrow('task ID');
  expect(() => parseAgentRuntimeRequest({ ...f.request(), action: 'submit', taskId: 'safe', prompt: ' ' })).toThrow('Enter a task');
  writeFileSync(join(f.home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-secret' } }));
  await fails(readRuntimeAuth(f.home), 'Sign in');
});

test('retries an interrupted bootstrap without creating a duplicate container', async () => {
  const f = fixture(); f.failBootstrap();
  await fails(f.runtime.request(f.workspace, f.request()), 'bootstrap interrupted');
  expect((await f.runtime.request(f.workspace, f.request())).details?.ready).toBe(true);
  expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
});

test('does not submit work through a previous login under the same account profile', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  writeFileSync(join(f.home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-new', refresh_token: 'fixture-refresh', id_token: 'fixture-id', account_id: 'different-account' } }));
  await fails(f.runtime.request(f.workspace, { ...f.request(), action: 'submit', taskId: 'new', prompt: 'work' }), 'earlier sign-in');
});

test('a previously used engine cannot be silently rebound to a different socket', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  writeFileSync(join(f.runtimePath, 'engine.json'), JSON.stringify({ engineId: f.request().engineId, host: 'unix:///tmp/original.sock' }));
  await fails(f.runtime.request(f.workspace, f.request()), 'original connection');
  expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
});

test('changing only the avatar does not invalidate or recreate a running worker', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  f.registry.save({ id: agent.id, revision: agent.revision, profile: { ...agent, avatar: { character: 'crab', color: 'pink' } },
    assignment: { assigned: true, instructions: 'Follow this project’s AGENTS.md.' } }, f.workspace);
  expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.error).toBeNull();
  await f.runtime.request(f.workspace, f.request());
  expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
  expect(f.calls.some(call => call.args.includes('rm'))).toBe(false);
});

test('Start rereads linked instructions and refreshes the worker without rewriting source files', async () => {
  const f = fixture(), common = join(f.home, 'common.md'), project = join(f.workspace, 'AGENTS.md');
  writeFileSync(common, 'Common rules'); writeFileSync(project, 'Project first');
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  f.registry.save({ id: agent.id, revision: agent.revision, profile: { ...agent, instructionFiles: [common] },
    assignment: { assigned: true, instructions: 'Project text', instructionFiles: [project] } }, f.workspace);
  await f.runtime.request(f.workspace, f.request());
  const installed = () => JSON.parse(f.calls.filter(call => call.input).at(-1)!.input!).configuration;
  expect(installed().instructions).toContain('Common rules'); expect(installed().instructions).toContain('Project first');
  const previous = installed().revision;
  await f.runtime.request(f.workspace, f.request());
  expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
  writeFileSync(project, 'Project second');
  expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.error).toBeNull();
  expect(installed().instructions).not.toContain('Project second');
  await f.runtime.request(f.workspace, f.request());
  expect(installed().revision).not.toBe(previous); expect(installed().instructions).toContain('Project second');
  expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(2);
  expect(readFileSync(common, 'utf8')).toBe('Common rules'); expect(readFileSync(project, 'utf8')).toBe('Project second');
  const calls = f.calls.length;
  rmSync(project);
  await fails(f.runtime.request(f.workspace, f.request()), project);
  expect(f.calls).toHaveLength(calls); // Read failure precedes even Docker discovery, let alone stop/remove.
  expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.ready).toBe(true);
});

test('unreadable files block first startup and changed instruction files cannot replace a busy worker', async () => {
  const f = fixture(), path = join(f.workspace, 'AGENTS.md');
  const agent = f.registry.snapshot(f.workspace).agents[0]!;
  f.registry.save({ id: agent.id, revision: agent.revision, profile: agent,
    assignment: { assigned: true, instructions: '', instructionFiles: [path] } }, f.workspace);
  await fails(f.runtime.request(f.workspace, f.request()), path); expect(f.calls).toHaveLength(0);
  writeFileSync(path, 'first'); await f.runtime.request(f.workspace, f.request());
  f.setBusy(); writeFileSync(path, 'second');
  await fails(f.runtime.request(f.workspace, f.request()), 'Wait for this worker');
  expect(f.calls.some(call => call.args.includes('stop') || call.args.includes('rm'))).toBe(false);
});

test('Homie task submission waits for host synchronization; failure never dispatches the task', async () => {
  const entered = registryDeferred<void>(), release = registryDeferred<void>();
  let fail = false, synchronized = false;
  const f = fixture(false, async workspace => {
    expect(workspace).toBe(realpathSync(f.workspace));
    entered.resolve(); await release.promise;
    if (fail) throw new Error('index synchronization failed');
    synchronized = true;
  });
  const posted: string[] = [];
  const fakeFetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    expect(synchronized).toBe(true); posted.push(String(input)); return Response.json({});
  }, { preconnect: fetch.preconnect });
  const mock = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  try {
    await f.runtime.request(f.workspace, f.request());
    const input = { ...f.request(), action: 'submit' as const, taskId: 'task', prompt: 'work' };
    const submitted = f.runtime.request(f.workspace, input);
    await entered.promise; expect(posted).toEqual([]);
    release.resolve(); await submitted;
    expect(posted).toEqual(['http://127.0.0.1:49831/tasks']);
    fail = true;
    await fails(f.runtime.request(f.workspace, input), 'synchronization failed');
    expect(posted).toHaveLength(1);
  } finally { release.resolve(); mock.mockRestore(); await f.runtime.dispose(); }
});

test('status and submission reject a saved configuration that does not match the actual worker', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  const path = join(f.runtimePath, 'runtime.json');
  const configuration = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...configuration, revision: 'different-container-configuration' }));
  expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.error).toContain('Settings changed');
  await fails(f.runtime.request(f.workspace, { ...f.request(), action: 'submit', taskId: 'task', prompt: 'work' }), 'Settings changed');
});

test.each(['recover', 'application-inspect'] as const)('%s posts only the scoped inspection request and preserves worker rejection details', async action => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  const calls: { url: string; body: unknown; authenticated: boolean }[] = [];
  let failure = false;
  const fakeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), authenticated: new Headers(init?.headers).get('Authorization')?.startsWith('Bearer ') === true });
    return failure ? Response.json({ error: 'The saved turn has not ended.' }, { status: 502 }) : Response.json({});
  }, { preconnect: fetch.preconnect });
  const mock = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  try {
    const extra = action === 'application-inspect' ? { candidateId: 'a'.repeat(64), hash: 'b'.repeat(64) } : {};
    const input = { ...f.request(), action, taskId: 'goal', roomId: 'room', ...extra };
    expect(() => parseAgentRuntimeRequest({ ...input, roomId: '../other' })).toThrow('room ID');
    expect(() => parseAgentRuntimeRequest({ ...input, taskId: '../other' })).toThrow('task ID');
    await f.runtime.request(f.workspace, input);
    expect(calls).toEqual([{ url: `http://127.0.0.1:49831/tasks/goal/${action === 'recover' ? 'recover' : 'application'}`, body: { roomId: 'room', ...extra }, authenticated: true }]);
    failure = true;
    await fails(f.runtime.request(f.workspace, input), 'has not ended');
    expect(calls).toHaveLength(2);
  } finally { mock.mockRestore(); await f.runtime.dispose(); }
});

test('question controls post only the authenticated owner task route with validated room and question', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    expect(new Headers(init?.headers).get('Authorization')?.startsWith('Bearer ')).toBe(true);
    return Response.json({});
  }, { preconnect: fetch.preconnect });
  const mock = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  try {
    const input = { ...f.request(), action: 'question' as const, taskId: 'goal', roomId: 'room', questionId: 'question', recipient: 'designer' };
    expect(() => parseAgentRuntimeRequest({ ...input, questionId: '../escape' })).toThrow('question control');
    expect(() => parseAgentRuntimeRequest({ ...input, recipient: undefined })).toThrow();
    await f.runtime.request(f.workspace, input);
    expect(calls).toEqual([{ url: 'http://127.0.0.1:49831/tasks/goal/question', body: { roomId: 'room', questionId: 'question', recipient: 'designer' } }]);
    const config = JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8'));
    expect(config.questionProtocol).toBe(2);
    const deadline = { ...input, action: 'question-deadline' as const, expiresAt: '2099-01-01T00:00:00.000Z' };
    expect(() => parseAgentRuntimeRequest({ ...deadline, expiresAt: undefined })).toThrow('deadline');
    await f.runtime.request(f.workspace, deadline);
    expect(calls.at(-1)).toEqual({ url: 'http://127.0.0.1:49831/tasks/goal/question-deadline', body: { roomId: 'room', questionId: 'question', expiresAt: deadline.expiresAt } });
  } finally { mock.mockRestore(); await f.runtime.dispose(); }
});

test.each([[1, false, false, false, false, false], [2, false, false, false, false, false], [3, false, false, false, false, false], [3, true, false, false, false, false], [3, true, true, false, false, false], [3, true, true, true, false, false], [3, true, true, true, true, false], [3, true, true, true, true, true]] as const)('worker upgrade from recovery %s, progress %s, work %s, integration %s, candidate %s, application %s preserves volume and unknown outcome', async (protocol, progress, work, integration, candidate, application) => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request()); f.legacyRecovery(protocol, progress, work, integration, candidate, application);
    const tasks = [{ id: 'q_question', status: 'unknown', prompt: 'Consult', output: '', error: 'Unconfirmed', createdAt: '2026-10-03' }];
    f.setTasks(tasks);
    const start = f.calls.length;
    const result = await f.runtime.request(f.workspace, f.request());
    expect(result.details?.tasks).toEqual(tasks);
    expect(JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8')).workProtocol).toBe(1);
    expect(JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8')).integrationProtocol).toBe(1);
    const changes = f.calls.slice(start);
    expect(changes.some(c => c.args.includes('stop'))).toBe(true);
    expect(changes.some(c => c.args.includes('create'))).toBe(true);
    expect(changes.some(c => c.args.includes('volume'))).toBe(false);
    const mounts = f.calls.filter(c => c.args.includes('create')).map(c => c.args.find(a => a.startsWith('type=volume,')));
    expect(mounts).toHaveLength(2); expect(mounts[0]).toBe(mounts[1]);
  } finally { await f.runtime.dispose(); }
});

test.each(['busy', 'running', 'accepted', 'settings', 'instructions', 'current-protocol'])('unknown worker upgrade still rejects %s', async reason => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request()); f.legacyRecovery(2);
    f.setTasks([{ id: 'q_question', status: 'unknown', prompt: 'Consult', output: '', error: null, createdAt: '2026-10-03' },
      ...(['running', 'accepted'].includes(reason) ? [{ id: 'active', status: reason, prompt: 'Work', output: '', error: null, createdAt: '2026-10-03' }] : [])]);
    if (reason === 'busy') f.setBusy();
    if (reason === 'settings') {
      const agent = f.registry.snapshot(f.workspace).agents[0]!;
      f.registry.save({ id: agent.id, revision: agent.revision, profile: { ...agent, permissions: { fileWrite: true, commandExecution: true } },
        assignment: { assigned: true, instructions: '' } }, f.workspace);
    }
    if (reason === 'instructions' || reason === 'current-protocol') {
      const filename = join(f.runtimePath, 'runtime.json'), config = JSON.parse(readFileSync(filename, 'utf8'));
      if (reason === 'instructions') config.instructions += 'changed'; else { config.recoveryProtocol = 3; config.progressProtocol = 1; config.workProtocol = 1; config.integrationProtocol = 1; config.candidateVerificationProtocol = 1; config.applicationProtocol = 1; config.applicationInspectionProtocol = 1; config.conversationProtocol = 1; }
      writeFileSync(filename, JSON.stringify(config));
    }
    await fails(f.runtime.request(f.workspace, f.request()), 'Wait for this worker');
    expect(f.calls.some(c => c.args.includes('stop') || c.args.includes('rm'))).toBe(false);
  } finally { await f.runtime.dispose(); }
});

test('conversation protocol upgrade preserves an unknown result and its existing named volume', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    f.legacyRecovery(3, true, true, true, true, true, true);
    const tasks = [{ id: 'goal', status: 'unknown', prompt: 'Build login', output: '', error: 'Unconfirmed', createdAt: '2026-10-03' }];
    f.setTasks(tasks);
    const start = f.calls.length;
    const result = await f.runtime.request(f.workspace, f.request());
    expect(result.details?.tasks).toEqual(tasks);
    expect(JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8')).conversationProtocol).toBe(1);
    expect(f.calls.slice(start).some(c => c.args.includes('volume'))).toBe(false);
    const mounts = f.calls.filter(c => c.args.includes('create')).map(c => c.args.find(a => a.startsWith('type=volume,')));
    expect(mounts).toHaveLength(2); expect(mounts[0]).toBe(mounts[1]);
  } finally { await f.runtime.dispose(); }
});

test('concurrent automatic requests start one worker without waiting recursively on the collaboration tick', async () => {
  const f = fixture();
  try {
    const state = await Promise.all([f.runtime.wake(f.workspace, { ...f.request(), action: 'status' }),
      f.runtime.wake(f.workspace, { ...f.request(), action: 'status' })]);
    expect(state.every(s => s.details?.ready === true)).toBe(true);
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
    expect(f.exchanges).toHaveLength(0);
  } finally { await f.runtime.dispose(); }
});


test('activity protocol upgrade preserves unknown tasks and the existing worker volume', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    f.legacyRecovery(3, true, true, true, true, true, true, true);
    const tasks = [{ id: 'goal', status: 'unknown', prompt: 'Build login', output: '', error: 'Unconfirmed', createdAt: '2026-10-03' }];
    f.setTasks(tasks);
    expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.error).toContain('Start the agent');
    expect((await f.runtime.request(f.workspace, f.request())).details?.tasks).toEqual(tasks);
    expect(JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8')).activityProtocol).toBe(1);
    const mounts = f.calls.filter(c => c.args.includes('create')).map(c => c.args.find(a => a.startsWith('type=volume,')));
    expect(mounts).toHaveLength(2); expect(mounts[0]).toBe(mounts[1]);
    expect(f.calls.some(c => c.args.includes('volume'))).toBe(false);
  } finally { await f.runtime.dispose(); }
});

test('input queue protocol upgrade preserves activity-era unknown work and its volume', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    f.legacyRecovery(3, true, true, true, true, true, true, true, true);
    const tasks = [{ id: 'goal', status: 'unknown', prompt: 'Build login', output: '', error: 'Unconfirmed', createdAt: '2026-10-03' }];
    f.setTasks(tasks);
    expect((await f.runtime.request(f.workspace, f.request())).details?.tasks).toEqual(tasks);
    expect(JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8')).inputQueueProtocol).toBe(1);
    const mounts = f.calls.filter(c => c.args.includes('create')).map(c => c.args.find(a => a.startsWith('type=volume,')));
    expect(mounts).toHaveLength(2); expect(mounts[0]).toBe(mounts[1]);
  } finally { await f.runtime.dispose(); }
});

test('Chats permission decisions verify saved requests, refuse busy work, and grant only the current project', async () => {
  const f = fixture();
  const permission = { id: 'permission', fileWrite: true, commandExecution: true, reason: 'Implement and test', status: 'pending' as const };
  const task = { id: 'permission-task', roomId: 'room', status: 'waiting', createdAt: '2026-10-06', prompt: 'Implement', output: '', error: null,
    inspection: { permissionRequest: permission, finishedAt: null, threadId: null, conversation: null, goal: null, messages: [], evidence: [], error: null } };
  const posts: { url: string; body: unknown }[] = [];
  const fakeFetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ status: 'allowed' });
  }, { preconnect: fetch.preconnect });
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  try {
    await f.runtime.request(f.workspace, f.request()); f.setTasks([task]);
    const input = { agentId: f.agentId, engineId: f.request().engineId, accountId: 'default', roomId: 'room', taskId: task.id, request: permission, decision: 'allow' as const };
    await fails(f.runtime.permissions(f.workspace, { ...input, accountId: 'other' }), 'account changed');
    await fails(f.runtime.permissions(f.workspace, { ...input, request: { ...permission, id: 'foreign' } }), 'request changed');
    expect(f.registry.snapshot(f.workspace).agents[0]!.permissions.fileWrite).toBe(false);
    await f.runtime.permissions(f.workspace, input);
    const agent = f.registry.snapshot(f.workspace).agents[0]!;
    expect(agent.permissions).toEqual({ fileWrite: false, commandExecution: false });
    expect(agent.assignments[0]?.permissions).toEqual({ fileWrite: true, commandExecution: true });
    expect(posts.at(-1)).toEqual({ url: 'http://127.0.0.1:49831/tasks/permission-task/permissions', body: { roomId: 'room', requestId: permission.id, decision: 'allow' } });
    expect(f.calls.filter(c => c.args.includes('rm'))).toHaveLength(1);
    f.setBusy(); const before = f.calls.length;
    await fails(f.runtime.permissions(f.workspace, input), 'Wait for');
    expect(f.calls.slice(before).some(c => c.args.includes('stop') || c.args.includes('rm'))).toBe(false);
  } finally { fetchMock.mockRestore(); await f.runtime.dispose(); }
});

test('failed permission application restores the previous project grant without changing the shared profile', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    const permission = { id: 'request', fileWrite: true, commandExecution: true, reason: 'Implement', status: 'pending' as const };
    f.setTasks([{ id: 'task', roomId: 'room', status: 'waiting', createdAt: '2026-10-06', prompt: 'Implement', output: '', error: null,
      inspection: { permissionRequest: permission, finishedAt: null, threadId: null, conversation: null, goal: null, messages: [], evidence: [], error: null } }]);
    f.failBootstrap();
    await fails(f.runtime.permissions(f.workspace, { ...f.request(), accountId: 'default', taskId: 'task', roomId: 'room', request: permission, decision: 'allow' }), 'bootstrap interrupted');
    const agent = f.registry.snapshot(f.workspace).agents[0]!;
    expect(agent.permissions).toEqual({ fileWrite: false, commandExecution: false });
    expect(agent.assignments[0]?.permissions).toBeUndefined();
  } finally { await f.runtime.dispose(); }
});


test('changing the shared instruction limit replaces only an idle worker and preserves its volume', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    const configuration = () => JSON.parse(readFileSync(join(f.runtimePath, 'runtime.json'), 'utf8'));
    expect(configuration().projectDocMaxBytes).toBe(32768);
    f.setProjectDocMaxBytes(131072);
    const status = await f.runtime.request(f.workspace, { ...f.request(), action: 'status' });
    expect(status.details?.error).toContain('Settings changed');
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(1);
    await f.runtime.request(f.workspace, f.request());
    expect(configuration().projectDocMaxBytes).toBe(131072);
    const created = f.calls.filter(call => call.args.includes('create'));
    expect(created).toHaveLength(2);
    const volume = (args: string[]) => args.find(arg => arg.startsWith('type=volume,src=cheshi-agent-'));
    expect(volume(created[1]!.args)).toBe(volume(created[0]!.args));
    await f.runtime.request(f.workspace, f.request());
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(2);
    f.setBusy(); f.setProjectDocMaxBytes(32768);
    await fails(f.runtime.request(f.workspace, f.request()), 'unfinished task');
    expect(f.calls.filter(call => call.args.includes('create'))).toHaveLength(2);
    expect(configuration().projectDocMaxBytes).toBe(131072);
  } finally { await f.runtime.dispose(); }
});

test('custom tool calls without a saved enabled definition are blocked before Docker execution', async () => {
  const f = fixture();
  try {
    await fails(f.runtime.testTool(f.workspace, { agentId: f.agentId, engineId: 'docker:colima-cheshi', tool: 'missing', args: {} }), 'saved definition');
    expect(f.calls).toEqual([]);
  } finally { await f.runtime.dispose(); }
});

test('explicit Start replaces workers that still advertise the retired history protocol', async () => {
  const f = fixture();
  try {
    await f.runtime.request(f.workspace, f.request());
    const filename = join(f.runtimePath, 'runtime.json');
    const saved = JSON.parse(readFileSync(filename, 'utf8'));
    expect(saved.historyProtocol).toBeUndefined();
    f.legacyHistory();
    const before = f.calls.filter(c => c.args.includes('create')).length;
    await f.runtime.request(f.workspace, f.request());
    expect(JSON.parse(readFileSync(filename, 'utf8')).historyProtocol).toBeUndefined();
    expect(f.calls.filter(c => c.args.includes('create')).length).toBe(before + 1);
  } finally { await f.runtime.dispose(); }
});
