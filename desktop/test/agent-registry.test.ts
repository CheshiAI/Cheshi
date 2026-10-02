import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';
import { AGENT_REGISTRY_CHANNELS, parseSaveSpecialistAgent } from '../shared/agent-registry.ts';
import type { AgentRegistrySnapshot } from '../shared/agent-registry.ts';
import { specialistInput } from './agent-registry-fixtures';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-agent-registry-'));
  const filename = path.join(directory, 'registry.json');
  return { directory, filename, registry: createAgentRegistry(filename), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('agent identities persist globally and assignments remain separate across projects', () => {
  const f = fixture();
  try {
    const input = specialistInput();
    const created = f.registry.save(input, '/projects/cheshi');
    const first = created.snapshot.agents[0]!;
    expect(first.id).not.toBe('/projects/cheshi');
    expect(first.revision).toBe(1);
    expect(first.assignments).toEqual([{ workspaceRoot: '/projects/cheshi', instructions: input.assignment.instructions }]);
    const reopened = createAgentRegistry(f.filename);
    expect(reopened.snapshot('/projects/second').agents).toEqual([first]);
    const second = reopened.save({ ...input, id: first.id, revision: first.revision,
      assignment: { assigned: true, instructions: 'Second project only' } }, '/projects/second').snapshot.agents[0]!;
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(second.assignments).toHaveLength(2);
    const detached = reopened.save({ ...input, id: second.id, revision: second.revision,
      assignment: { assigned: false, instructions: '' } }, '/projects/cheshi').snapshot.agents[0]!;
    expect(detached.assignments).toEqual([{ workspaceRoot: '/projects/second', instructions: 'Second project only' }]);
    expect(detached.createdAt).toBe(first.createdAt);
    if (process.platform !== 'win32') expect(statSync(f.filename).mode & 0o777).toBe(0o600);
  } finally { f.close(); }
});

test('stale saves and duplicate names do not overwrite agent data or publish updates', () => {
  const f = fixture();
  try {
    let notifications = 0;
    const unsubscribe = f.registry.subscribe(() => { notifications++; });
    const input = specialistInput(), agent = f.registry.save(input, '/projects/one').snapshot.agents[0]!;
    f.registry.save({ ...input, id: agent.id, revision: 1 }, '/projects/two');
    const before = readFileSync(f.filename, 'utf8');
    expect(() => f.registry.save({ ...input, id: agent.id, revision: 1 }, '/projects/one')).toThrow('another window');
    expect(() => f.registry.save(input, '/projects/one')).toThrow('already exists');
    expect(readFileSync(f.filename, 'utf8')).toBe(before);
    expect(notifications).toBe(2);
    unsubscribe();
    f.registry.save({ ...input, id: agent.id, revision: 2 }, '/projects/one');
    expect(notifications).toBe(2);
  } finally { f.close(); }
});

test('invalid configuration and corrupt saved data fail without changing storage', () => {
  const f = fixture();
  try {
    const input = specialistInput();
    for (const fileWrite of ['true', 1, null]) {
      expect(() => parseSaveSpecialistAgent({ ...input, profile: { ...input.profile,
        permissions: { fileWrite, commandExecution: false } } })).toThrow('permission');
    }
    expect(() => f.registry.save({ ...input, profile: { ...input.profile, name: ' ' } }, '/projects/one')).toThrow('text');
    expect(() => f.registry.save({ ...input, assignment: { assigned: 'true', instructions: '' } }, '/projects/one')).toThrow();
    expect(() => f.registry.save(input, 'relative/project')).toThrow('absolute');
    expect(() => f.registry.save({ ...input, revision: 1 }, '/projects/one')).toThrow('together');
    writeFileSync(f.filename, '{damaged');
    expect(() => f.registry.save(input, '/projects/one')).toThrow();
    expect(readFileSync(f.filename, 'utf8')).toBe('{damaged');
    writeFileSync(f.filename, JSON.stringify({ version: 2, agents: [] }));
    expect(() => f.registry.snapshot('/projects/one')).toThrow('Unsupported');
  } finally { f.close(); }
});

test('registry persists account references and strips unrecognized fields', () => {
  const f = fixture();
  try {
    const input = specialistInput();
    const result = f.registry.save({ ...input, profile: { ...input.profile, accountId: 'account-fixture', model: 'model-fixture',
      reasoningEffort: 'high', serviceTier: 'priority',
      extra: 'must-not-be-stored' } }, '/projects/one');
    expect(result.snapshot.agents[0]).toMatchObject({ accountId: 'account-fixture', model: 'model-fixture' });
    expect(readFileSync(f.filename, 'utf8')).not.toContain('must-not-be-stored');
    expect(createAgentRegistry(f.filename).snapshot('/projects/one').agents[0]).toMatchObject({
      model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority',
    });
  } finally { f.close(); }
});

test('registry IPC binds assignment to its owner workspace and broadcasts across windows', async () => {
  const f = fixture();
  const bridge = (workspaceRoot: string) => {
    const renderer = new EventEmitter();
    const owner = { mainFrame: {}, isDestroyed: () => false, send: (channel: string, value: unknown) => { renderer.emit(channel, {}, value); } };
    const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const registration = registerAgentRegistryIpc({ window, workspaceRoot, registry: f.registry,
      remove: async value => f.registry.remove(value, workspaceRoot),
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
    const event = { sender: owner, senderFrame: owner.mainFrame } as IpcMainInvokeEvent;
    const api = createAgentRegistryApi(Object.assign(renderer, {
      invoke: async (channel: string, value?: unknown) => handlers.get(channel)!(event, value),
    }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
    return { api, handlers, event, window, registration };
  };
  const a = bridge('/projects/one'), b = bridge('/projects/two');
  try {
    const snapshots: AgentRegistrySnapshot[] = [];
    const unsubscribe = b.api.onDidChange(snapshot => snapshots.push(snapshot));
    const save = a.handlers.get(AGENT_REGISTRY_CHANNELS.save)!;
    expect(() => save({ ...a.event, sender: {} } as IpcMainInvokeEvent, specialistInput())).toThrow('workspace window');
    expect(() => save({ ...a.event, senderFrame: {} } as IpcMainInvokeEvent, specialistInput())).toThrow('workspace window');
    await save(a.event, { ...specialistInput(), workspaceRoot: '/projects/foreign' });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.workspaceRoot).toBe('/projects/two');
    expect(snapshots[0]?.agents[0]?.assignments[0]?.workspaceRoot).toBe('/projects/one');
    expect((await b.api.list()).agents).toEqual((await a.api.list()).agents);
    const agent = (await a.api.list()).agents[0]!;
    const deletion = { id: agent.id, revision: agent.revision, deleteData: false };
    const remove = a.handlers.get(AGENT_REGISTRY_CHANNELS.remove)!;
    expect(() => remove({ ...a.event, sender: {} } as IpcMainInvokeEvent, deletion)).toThrow('workspace window');
    expect(() => remove({ ...a.event, senderFrame: {} } as IpcMainInvokeEvent, deletion)).toThrow('workspace window');
    expect(() => remove(a.event, { ...deletion, deleteData: 'true' })).toThrow('permission');
    expect((await a.api.remove!(deletion)).agents).toHaveLength(0);
    expect(snapshots.at(-1)?.agents).toHaveLength(0);
    a.window.emit('closed');
    expect(a.handlers.size).toBe(0);
    expect(() => save(a.event, specialistInput())).toThrow('workspace window');
    unsubscribe();
    expect(b.window.listenerCount('closed')).toBe(1);
  } finally { a.registration.dispose(); b.registration.dispose(); f.close(); }
});
