import { defaultAgentAvatar } from '../shared/agent-avatar';
import { specialistAgent } from './agent-registry-fixtures';
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
import { WorkerOperationBusyError } from '../lib/agent-management/operations.mts';
import { UnresolvedApplicationError } from '../../experiments/codex-specialists/src/application-storage.ts';

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
  let deletionBusy = false;
  let applicationUnresolved = false;
  const bridge = (workspaceRoot: string) => {
    const renderer = new EventEmitter();
    const owner = { mainFrame: {}, isDestroyed: () => false, send: (channel: string, value: unknown) => { renderer.emit(channel, {}, value); } };
    const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const registration = registerAgentRegistryIpc({ window, workspaceRoot, registry: f.registry,
      remove: async value => {
        if (deletionBusy) throw new WorkerOperationBusyError('Nothing was deleted. Try again shortly.');
        if (applicationUnresolved) throw new UnresolvedApplicationError();
        return f.registry.remove(value, workspaceRoot);
      },
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
    deletionBusy = true;
    expect(await remove(a.event, deletion)).toEqual({ status: 'busy', message: 'Nothing was deleted. Try again shortly.' });
    let busy: unknown;
    try { await a.api.remove!(deletion); } catch (error) { busy = error; }
    expect(busy).toBeInstanceOf(Error); expect((busy as Error).message).toBe('Nothing was deleted. Try again shortly.');
    expect((await a.api.list()).agents).toHaveLength(1);
    deletionBusy = false;
    applicationUnresolved = true;
    expect(await remove(a.event, deletion)).toEqual({ status: 'blocked', message: new UnresolvedApplicationError().message });
    let blocked: unknown;
    try { await a.api.remove!(deletion); } catch (error) { blocked = error; }
    expect(blocked).toBeInstanceOf(Error); expect((blocked as Error).message).toContain('Inspect application');
    expect((await a.api.list()).agents).toHaveLength(1);
    applicationUnresolved = false;
    expect((await a.api.remove!(deletion)).agents).toHaveLength(0);
    expect(snapshots.at(-1)?.agents).toHaveLength(0);
    a.window.emit('closed');
    expect(a.handlers.size).toBe(0);
    expect(() => save(a.event, specialistInput())).toThrow('workspace window');
    unsubscribe();
    expect(b.window.listenerCount('closed')).toBe(1);
  } finally { a.registration.dispose(); b.registration.dispose(); f.close(); }
});

test('avatar selections persist across restarts and older clients preserve them when editing', () => {
  const f = fixture();
  try {
    const input = specialistInput();
    const created = f.registry.save(input, '/project').snapshot.agents[0]!;
    expect(created.avatar).toBeDefined();
    const avatar = { character: 'crab', color: 'pink' } as const;
    const saved = f.registry.save({ ...input, id: created.id, revision: created.revision,
      profile: { ...input.profile, avatar } }, '/project').snapshot.agents[0]!;
    const reopened = createAgentRegistry(f.filename);
    expect(reopened.snapshot('/project').agents[0]!.avatar).toEqual(avatar);
    expect(reopened.save({ ...input, id: saved.id, revision: saved.revision }, '/project').snapshot.agents[0]!.avatar).toEqual(avatar);
    const before = readFileSync(f.filename, 'utf8');
    expect(() => reopened.save({ ...input, profile: { ...input.profile, avatar: { character: 'invalid', color: 'pink' } } }, '/project')).toThrow('icon');
    expect(readFileSync(f.filename, 'utf8')).toBe(before);
  } finally { f.close(); }
});
test('legacy agent icons are derived from identity without rewriting existing registrations', () => {
  const f = fixture();
  try {
    const agent = specialistAgent();
    writeFileSync(f.filename, JSON.stringify({ version: 1, agents: [agent] }));
    const before = readFileSync(f.filename, 'utf8');
    expect(f.registry.snapshot('/project').agents[0]!.avatar).toEqual(defaultAgentAvatar(agent.id));
    expect(createAgentRegistry(f.filename).snapshot('/another').agents[0]!.avatar).toEqual(defaultAgentAvatar(agent.id));
    expect(readFileSync(f.filename, 'utf8')).toBe(before);
  } finally { f.close(); }
});

test('instruction file links persist separately per project and unlinking preserves originals', () => {
  const f = fixture();
  try {
    const original = path.join(f.directory, 'AGENTS.md'); writeFileSync(original, 'original contents');
    const input = specialistInput();
    let agent = f.registry.save({ ...input, profile: { ...input.profile, instructionFiles: ['/common/rules.md'] },
      assignment: { assigned: true, instructions: '', instructionFiles: [original] } }, '/one').snapshot.agents[0]!;
    agent = f.registry.save({ ...input, id: agent.id, revision: agent.revision,
      assignment: { assigned: true, instructions: '', instructionFiles: ['/two/AGENTS.md'] } }, '/two').snapshot.agents[0]!;
    expect(agent.instructionFiles).toEqual(['/common/rules.md']);
    const reopened = createAgentRegistry(f.filename);
    agent = reopened.save({ ...input, id: agent.id, revision: agent.revision }, '/one').snapshot.agents[0]!;
    expect(agent.assignments.find(item => item.workspaceRoot === '/one')?.instructionFiles).toEqual([original]);
    agent = reopened.save({ ...input, id: agent.id, revision: agent.revision, profile: { ...input.profile, instructionFiles: [] },
      assignment: { assigned: true, instructions: '', instructionFiles: [] } }, '/one').snapshot.agents[0]!;
    expect(agent.instructionFiles).toEqual([]);
    expect(agent.assignments.find(item => item.workspaceRoot === '/one')?.instructionFiles).toEqual([]);
    expect(agent.assignments.find(item => item.workspaceRoot === '/two')?.instructionFiles).toEqual(['/two/AGENTS.md']);
    expect(readFileSync(original, 'utf8')).toBe('original contents');
    expect(readFileSync(f.filename, 'utf8')).not.toContain('original contents');
  } finally { f.close(); }
});

test('file IPC validates ownership and only opens selected or linked Markdown files', async () => {
  const f = fixture(), file = path.join(f.directory, 'AGENTS.md'), opened: string[] = [];
  writeFileSync(file, 'rules');
  const owner = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  let selection: string[] = [];
  const registration = registerAgentRegistryIpc({ window, workspaceRoot: f.directory, registry: f.registry,
    selectInstructionFiles: async () => selection, openInstructionFile: async value => { opened.push(value); },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
  const renderer = new EventEmitter();
  const api = createAgentRegistryApi(Object.assign(renderer, {
    invoke: async (channel: string, value?: unknown) => handlers.get(channel)!(event, value),
  }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  const fails = async (operation: Promise<unknown>, message: string) => {
    let error: unknown;
    try { await operation; } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain(message);
  };
  try {
    const select = handlers.get(AGENT_REGISTRY_CHANNELS.selectInstructionFiles)!;
    expect(() => select({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow('workspace window');
    expect(await api.selectInstructionFiles!()).toEqual([]);
    await fails(api.openInstructionFile!(file), 'Select or link');
    selection = [file]; expect(await api.selectInstructionFiles!()).toEqual([file]);
    await api.openInstructionFile!(file); expect(opened).toEqual([file]);
    await fails(api.openInstructionFile!('/tmp/script.sh'), 'Markdown');
    rmSync(file); await fails(api.openInstructionFile!(file), 'Cannot read'); expect(opened).toHaveLength(1);
    window.emit('closed'); expect(handlers.size).toBe(0);
    expect(() => select(event)).toThrow('workspace window');
  } finally { registration.dispose(); f.close(); }
});
