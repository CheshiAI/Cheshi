import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync as createSymbolicLink, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpecialistRuntime, readRuntimeAuth } from '../lib/agent-management/runtime.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { specialistInput } from './agent-registry-fixtures.ts';
import { parseAgentRuntimeRequest } from '../shared/agent-runtime.ts';
import type { AgentDetails } from '../shared/agent-management.ts';
import type { DockerCommand } from '../lib/agent-management/docker.mts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fails(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (reason) { error = reason; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
}
function fixture(linkedWorkspace = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-runtime-')); directories.push(directory);
  const project = join(directory, 'project'), home = join(directory, 'account');
  mkdirSync(project); mkdirSync(home);
  const workspace = linkedWorkspace ? join(directory, 'project-link') : project;
  if (linkedWorkspace) createSymbolicLink(project, workspace);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id', account_id: 'fixture-account' }, secret_extra: 'exclude' }));
  const registry = createAgentRegistry(join(directory, 'registry.json'));
  const input = specialistInput(); input.profile.accountId = 'default';
  const agentId = registry.save(input, workspace).agentId;
  let created = false, remote = false, busy = false, seeded = false, failSeed = false;
  let labels: Record<string, string> = {};
  const calls: { args: string[]; input?: string }[] = [];
  const runtimePath = join(directory, 'runtime', createHash('sha256').update('docker:colima-cheshi').digest('hex'),
    `${agentId}-${createHash('sha256').update(realpathSync(workspace)).digest('hex').slice(0, 16)}`);
  const id = 'a'.repeat(64);
  const run: DockerCommand = async (args, input) => {
    calls.push({ args, input });
    if (args.includes('exec')) {
      if (args.at(-1)?.includes('createHash')) return seeded ? createHash('sha256').update('fixture-account').digest('hex') : '';
      if (!input) return seeded ? 'configured' : 'pending';
      if (failSeed) { failSeed = false; throw new Error('bootstrap interrupted'); }
      seeded = true; return '';
    }
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: remote ? 'ssh://other' : 'unix:///tmp/docker.sock' } } }]);
    if (args.includes('ls')) return created ? id : '';
    if (args.includes('inspect')) return JSON.stringify([{ Id: id, Name: '/worker', Config: { Image: 'worker', Labels: labels },
      State: { Status: 'running' }, NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '49831' }] } } }]);
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
  const details = (): AgentDetails => ({ agent: { id, name: 'worker', image: 'worker', state: 'running' },
    ready: seeded, busy, authenticated: true, threadId: null, error: null, logs: '', tasks: [] });
  const exchanges: unknown[] = [];
  const runtime = createSpecialistRuntime({ directory: join(directory, 'runtime'), buildContext: '/build', registry, run,
    collaborationExchange: async (_connection, body) => { exchanges.push(body); return { protocol: 1, received: [], outgoing: [] }; },
    account: async () => ({ home, models: [] }), management: { details: async () => details(),
      engines: async () => ({ engines: [], error: null }), snapshot: async engineId => ({ engineId, online: true, error: null, agents: [] }),
      control: async () => { throw new Error('unused'); } } });
  return { runtime, registry, workspace, home, runtimePath, agentId, calls, exchanges, failBootstrap: () => { failSeed = true; }, setBusy: () => { busy = true; }, setRemote: () => { remote = true; },
    request: () => ({ agentId, engineId: 'docker:colima-cheshi', action: 'start' as const }) };
}
test('starts one project worker with isolated storage, readonly mount, private auth input and persisted settings', async () => {
  const f = fixture();
  expect((await f.runtime.request(f.workspace, f.request())).details?.ready).toBe(true);
  const args = f.calls.find(call => call.args.includes('create'))!.args;
  expect(args).toContain(`type=bind,src=${realpathSync(f.workspace)},dst=/workspace,readonly`);
  expect(args).toContain('no-new-privileges:true'); expect(args).toContain('apparmor=cheshi-codex-bwrap');
  const config = JSON.parse(f.calls.find(call => call.input)!.input!).configuration;
  expect(args.some(arg => arg.includes('runtime.json,readonly'))).toBe(false);
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

test('status and submission reject a saved configuration that does not match the actual worker', async () => {
  const f = fixture(); await f.runtime.request(f.workspace, f.request());
  const path = join(f.runtimePath, 'runtime.json');
  const configuration = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...configuration, revision: 'different-container-configuration' }));
  expect((await f.runtime.request(f.workspace, { ...f.request(), action: 'status' })).details?.error).toContain('Settings changed');
  await fails(f.runtime.request(f.workspace, { ...f.request(), action: 'submit', taskId: 'task', prompt: 'work' }), 'Settings changed');
});
