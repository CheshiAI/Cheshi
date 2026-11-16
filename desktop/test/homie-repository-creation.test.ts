import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';
import { WorkspaceProjectStore } from '../lib/workspace-project-store.mts';
import { specialistInput, registryDeferred } from './agent-registry-fixtures';
import { HomieRepositoryProjects } from '../lib/agent-management/homie-repository-project.mts';

async function rejected(operation: Promise<unknown>, message: RegExp) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(message);
}

async function fixture(run: (f: {
  api: ReturnType<typeof createAgentRegistryApi>; registry: ReturnType<typeof createAgentRegistry>;
  projects: WorkspaceProjectStore; root: string; repository: string; renderer: EventEmitter;
  control: { calls: number; starts: number; failure: string; gate: Promise<void> | null; destroyed: boolean };
}) => Promise<void>) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cheshi-homie-creation-')));
  const root = path.join(base, 'app'), repository = path.join(base, 'homies'), data = path.join(base, 'data');
  await Promise.all([mkdir(root), mkdir(repository)]);
  const registry = createAgentRegistry(path.join(data, 'registry.json'));
  const projects = new WorkspaceProjectStore(data, root);
  const renderer = new EventEmitter(), control = { calls: 0, starts: 0, failure: '', gate: null as Promise<void> | null, destroyed: false };
  const repositories = new HomieRepositoryProjects({ stateDirectory: path.join(data, 'repositories'), projectsDirectory: repository,
    run: async (_command, args) => args.at(-1) === 'user'
      ? { code: 0, stdout: JSON.stringify({ id: 42, login: 'test-user' }), stderr: '' }
      : { code: 1, stdout: '', stderr: 'HTTP 404' } });
  const owner = { mainFrame: {}, isDestroyed: () => control.destroyed, send: (channel: string, value?: unknown) => renderer.emit(channel, {}, value) };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const bridge = registerAgentRegistryIpc({ window, workspaceRoot: root, registry,
    prepareCreation: async agent => {
      control.calls++;
      if (control.failure) throw new Error(control.failure);
      if (control.gate) await control.gate;
      const plan = await repositories.plan(agent);
      await mkdir(plan.directory, { recursive: true });
      await new WorkspaceProjectStore(data, root).add(plan.directory);
    },
    runtime: async () => { control.starts++; return { details: null }; },
    ipc: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
  });
  const api = createAgentRegistryApi(Object.assign(renderer, {
    invoke: async (channel: string, value?: unknown) => handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent, value),
  }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  try { await run({ api, registry, projects, root, repository, renderer, control }); }
  finally { bridge.dispose(); await rm(base, { recursive: true, force: true }); }
}

test('new Homies prepare once per save, link the permanent project and reveal Explorer only after a successful save', async () => {
  await fixture(async f => {
    let projectsChanged = 0, revealed = 0;
    const unsubscribeProjects = f.projects.subscribe(() => { projectsChanged++; });
    const unsubscribeReady = f.api.onRepositoryReady!(() => {
      expect(f.projects.list().some(project => project.rootPath.startsWith(f.repository + path.sep))).toBe(true);
      expect(f.registry.snapshot(f.root).agents.length).toBeGreaterThan(0);
      revealed++;
    });
    const first = await f.api.save(specialistInput());
    expect(revealed).toBe(1);
    expect(projectsChanged).toBe(1);
    await f.api.save({ ...specialistInput(), profile: { ...specialistInput().profile, name: 'Second Homie' } });
    expect(revealed).toBe(2);
    expect(projectsChanged).toBe(2);
    expect(f.projects.list()).toHaveLength(3);
    f.control.failure = 'Offline';
    const agent = first.snapshot.agents[0]!;
    await f.api.save({ ...specialistInput(), id: agent.id, revision: agent.revision });
    expect(f.control.calls).toBe(2);
    expect(revealed).toBe(2);
    unsubscribeReady(); unsubscribeProjects();
    expect(f.renderer.listenerCount('cheshi:agent-registry:repository-ready')).toBe(0);
  });
});

test('repository failure retains one saved Homie, blocks runtime and retries repository setup before starting', async () => {
  await fixture(async f => {
    let revealed = 0;
    const unsubscribe = f.api.onRepositoryReady!(() => { revealed++; });
    f.control.failure = 'Repository setup failed';
    const saved = await f.api.save(specialistInput());
    expect(saved.repositoryError).toBe('Repository setup failed');
    expect(f.registry.snapshot(f.root).agents).toHaveLength(1);
    expect(f.projects.list()).toHaveLength(1);
    expect(revealed).toBe(0);
    const request = { agentId: saved.agentId, engineId: 'docker:local', action: 'start' as const };
    await rejected(f.api.runtime!(request), /Repository setup failed/);
    expect(f.control.starts).toBe(0);
    f.control.failure = '';
    await f.api.runtime!(request);
    expect(f.registry.snapshot(f.root).agents).toHaveLength(1);
    expect(revealed).toBe(1);
    expect(f.control.starts).toBe(1);
    await f.api.runtime!(request);
    expect(f.projects.list()).toHaveLength(2);
    unsubscribe();
  });
});

test('closing the originating window during setup retains the saved Homie without publishing a reveal event', async () => {
  await fixture(async f => {
    const gate = registryDeferred<void>();
    f.control.gate = gate.promise;
    let revealed = 0;
    const unsubscribe = f.api.onRepositoryReady!(() => { revealed++; });
    const pending = f.api.save(specialistInput());
    f.control.destroyed = true;
    gate.resolve();
    await rejected(pending, /closed/);
    expect(f.registry.snapshot(f.root).agents).toHaveLength(1);
    expect(revealed).toBe(0);
    unsubscribe();
  });
});
