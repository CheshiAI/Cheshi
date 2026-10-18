import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HomieRepositoryProjects } from '../lib/agent-management/homie-repository-project.mts';
import { connectHomieRepository } from '../lib/agent-management/homie-repository-registration.mts';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { homieRepositoryTemplate } from '../lib/agent-management/homie-repository-template.mts';
import { readHomieSource } from '../lib/agent-management/homie-source-files.mts';
import { parseHomieRepository } from '../shared/homie-repository-connection.ts';
import type { RepositoryCommand } from '../lib/agent-management/homie-repository-command.mts';
import { specialistAgent, specialistInput } from './agent-registry-fixtures';
import { HomieSources } from '../lib/agent-management/homie-sources.mts';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';

const execute = promisify(execFile);
const repository = 'CheshiAI/Homie-atlas', url = `https://github.com/${repository}.git`;
async function rejected(operation: Promise<unknown>, message: RegExp) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(message);
}
async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'homie-connect-')));
  const source = path.join(base, 'source'), projects = path.join(base, 'projects'), mappings = path.join(base, 'mappings');
  await mkdir(source);
  for (const [name, text] of Object.entries(await homieRepositoryTemplate({ ...specialistAgent(), name: 'Atlas' }))) {
    await writeFile(path.join(source, name), text);
  }
  await execute('git', ['init', '-b', 'main'], { cwd: source });
  await execute('git', ['add', '.'], { cwd: source });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture'], { cwd: source });
  const state = { missing: false, failure: '', private: true };
  const calls: string[][] = [];
  const run: RepositoryCommand = async (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command === 'gh') {
      expect(args.includes('POST')).toBe(false);
      if (args.at(-1) === 'user') return { code: 0, stdout: JSON.stringify({ id: 12, login: 'alice' }), stderr: '' };
      if (state.failure || state.missing) return { code: 1, stdout: '', stderr: state.failure || 'HTTP 404' };
      return { code: 0, stdout: JSON.stringify({ id: 10, full_name: repository, private: state.private }), stderr: '' };
    }
    expect(['push', 'commit', 'reset', 'clean', 'pull'].includes(args[0]!)).toBe(false);
    try {
      const result = await execute('git', args.map(value => value === url ? source : value), { cwd });
      if (args[0] === 'clone') await execute('git', ['remote', 'set-url', 'origin', url], { cwd: args.at(-1)! });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (cause) { return { code: 1, stdout: '', stderr: String(cause) }; }
  };
  const repositories = new HomieRepositoryProjects({ stateDirectory: mappings, projectsDirectory: projects, run });
  const registry = createAgentRegistry(path.join(base, 'registry.json'));
  const connect = async (hash?: string, unavailable = false) => {
    const preview = await repositories.previewExisting(repository);
    const input = { ...specialistInput(), repository: { repository, hash: hash ?? preview.hash },
      profile: { ...specialistInput().profile, name: 'Untrusted name', instructions: 'Untrusted instructions', ...preview.definition.model } };
    return connectHomieRepository({ repositories, registry, workspaceRoot: source, input,
      assertAvailable: () => { if (unavailable) throw new Error('Window closed'); } });
  };
  return { base, source, projects, mappings, repositories, registry, calls, state, connect,
    dispose: () => rm(base, { recursive: true, force: true }) };
}

test('existing GitHub source is cloned, reviewed and registered without remote writes', async () => {
  const f = await fixture();
  try {
    const preview = await f.repositories.previewExisting(`https://github.com/${repository}`);
    expect(preview.definition.name).toBe('Atlas');
    expect(f.registry.snapshot(f.source).agents).toHaveLength(0);
    await writeFile(path.join(preview.directory, 'local-notes.md'), 'Keep this draft');
    const saved = await f.connect();
    const agent = saved.snapshot.agents[0]!;
    expect(agent.name).toBe('Atlas');
    expect(agent.instructions).toBe(preview.definition.instructions);
    expect(agent.package).toEqual(preview.definition);
    expect(agent.permissions).toEqual({ fileWrite: false, commandExecution: false });
    expect(await f.repositories.local(agent.id)).toMatchObject({ repository, directory: preview.directory, existingOnly: true });
    expect((await f.repositories.ensure(agent)).created).toBe(false);
    expect((await readHomieSource(preview.directory)).hash).toBe(preview.hash);
    const sources = new HomieSources({ directory: path.join(f.base, 'sources'), repositories: f.repositories, registry: f.registry });
    expect((await sources.status(f.source, agent.id)).phase).toBe('pending');
    expect(await readFile(path.join(preview.directory, 'local-notes.md'), 'utf8')).toBe('Keep this draft');
    expect(f.calls.filter(call => call[1] === 'clone')).toHaveLength(1);
    await rejected(f.repositories.previewExisting(repository.toLowerCase()), /already connected/);
  } finally { await f.dispose(); }
});

test('failed checks, stale previews and closed windows cannot leave a registration or mapping', async () => {
  const f = await fixture();
  try {
    f.state.missing = true;
    await rejected(f.repositories.previewExisting(repository), /unavailable/);
    f.state.missing = false; f.state.failure = 'HTTP 403';
    await rejected(f.repositories.previewExisting(repository), /denied/);
    f.state.failure = ''; f.state.private = false;
    await rejected(f.repositories.previewExisting(repository), /private/);
    f.state.private = true;
    await rejected(f.connect('a'.repeat(64)), /changed/);
    await rejected(f.connect(undefined, true), /closed/);
    expect(f.registry.snapshot(f.source).agents).toHaveLength(0);
    expect((await readdir(f.mappings)).filter(name => name.endsWith('.json'))).toHaveLength(0);
    expect((await f.connect()).snapshot.agents).toHaveLength(1);
  } finally { await f.dispose(); }
});

test('occupied checkout with a different origin is preserved', async () => {
  const f = await fixture();
  try {
    const preview = await f.repositories.previewExisting(repository);
    await execute('git', ['remote', 'set-url', 'origin', 'https://github.com/Other/Project.git'], { cwd: preview.directory });
    await rejected(f.repositories.previewExisting(repository), /different repository/);
    expect((await readHomieSource(preview.directory)).hash).toBe(preview.hash);
    expect(f.registry.snapshot(f.source).agents).toHaveLength(0);
  } finally { await f.dispose(); }
});

test('concurrent registration connects exactly one Homie', async () => {
  const f = await fixture();
  try {
    const preview = await f.repositories.previewExisting(repository);
    const save = (id: string) => f.registry.save(specialistInput(), f.source, id);
    const results = await Promise.allSettled([f.repositories.connectExisting(preview, save), f.repositories.connectExisting(preview, save)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.registry.snapshot(f.source).agents).toHaveLength(1);
  } finally { await f.dispose(); }
});

test('repository URLs are bounded to GitHub owner/name without credentials or revision paths', () => {
  expect(parseHomieRepository(`https://github.com/${repository}.git`)).toBe(repository);
  for (const value of ['https://evil.example/a/b', 'https://token@github.com/a/b', 'a/..', 'a/b/tree/main', '-x/b']) {
    expect(() => parseHomieRepository(value)).toThrow('GitHub');
  }
});

test('preload and IPC carry the reviewed repository into registration and preserve a single identity', async () => {
  const f = await fixture();
  const owner = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const prepared: string[] = [];
  const registration = registerAgentRegistryIpc({ window, registry: f.registry, workspaceRoot: f.source,
    previewRepository: repository => f.repositories.previewExisting(repository),
    connectRepository: (input, assertAvailable) => connectHomieRepository({ repositories: f.repositories,
      registry: f.registry, workspaceRoot: f.source, input, assertAvailable }),
    prepareCreation: async agent => { prepared.push(agent.id); },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
  const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string, input: unknown) => handlers.get(channel)!(event, input) });
  const api = createAgentRegistryApi(ipc as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  try {
    const preview = await api.previewRepository!(url);
    const input = { ...specialistInput(), repository: { repository: preview.repository, hash: preview.hash } };
    const saved = await api.save(input);
    expect(saved.snapshot.agents[0]!.name).toBe('Atlas');
    expect(prepared).toEqual([saved.agentId]);
    await rejected(api.save(input), /already connected/);
    expect((await api.list()).agents).toHaveLength(1);
  } finally { registration.dispose(); await f.dispose(); }
});

test('a registered package identity is not duplicated through a new connection', async () => {
  const f = await fixture();
  try {
    const preview = await f.repositories.previewExisting(repository);
    f.registry.save({ ...specialistInput(), profile: { ...specialistInput().profile, package: preview.definition } }, f.source);
    await rejected(f.connect(), /already registered/);
    expect(f.registry.snapshot(f.source).agents).toHaveLength(1);
    expect((await readdir(f.mappings)).filter(name => name.endsWith('.json'))).toHaveLength(0);
  } finally { await f.dispose(); }
});
