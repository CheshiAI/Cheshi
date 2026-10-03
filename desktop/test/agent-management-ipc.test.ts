import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerAgentManagementIpc } from '../lib/agent-management/ipc.mts';
import { createAgentManagementApi } from '../lib/agent-management-preload.cts';
import { AGENT_CHANNELS, parseAgentSnapshot } from '../shared/agent-management.ts';
import { AGENT_TERMINAL_CHANNELS } from '../shared/agent-terminal.ts';
import type { AgentManagementApi } from '../shared/agent-management.ts';
import config from '../../forge.config.mts';

test('workspace IPC refuses foreign senders, subframes and invalid control actions', async () => {
  const events = new EventEmitter(), mainFrame = {};
  const owner = { mainFrame, isDestroyed: () => false };
  const window = Object.assign(events, { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  let calls = 0;
  const service: AgentManagementApi = {
    engines: async () => ({ engines: [], error: null }),
    snapshot: async engineId => ({ engineId, online: true, agents: [], error: null }),
    details: async () => { throw new Error('unused'); },
    control: async engineId => { calls++; return { engineId, online: true, agents: [], error: null }; },
  };
  const ipc = { handle: (name: string, fn: Parameters<IpcMain['handle']>[1]) => { handlers.set(name, fn); },
    removeHandler: (name: string) => { handlers.delete(name); } };
  let terminalCalls = 0, terminalDisposed = false;
  const removals: unknown[] = [];
  const registration = registerAgentManagementIpc({ window, ipc, service, remove: async value => { removals.push(value); }, terminal: {
    open: async (engineId, agentId) => { terminalCalls++; return { id: 'session', engineId, agentId, ended: false, error: null }; },
    update: async () => {}, close: async () => {}, dispose: () => { terminalDisposed = true; },
  } });
  const invoke = (sender: unknown, frame: unknown, action: unknown) => handlers.get(AGENT_CHANNELS.control)!(
    { sender, senderFrame: frame } as IpcMainInvokeEvent, 'docker:colima-cheshi', 'worker', action);
  expect(() => invoke({}, mainFrame, 'stop')).toThrow('workspace window');
  expect(() => invoke(owner, {}, 'stop')).toThrow('workspace window');
  expect(() => invoke(owner, mainFrame, 'delete')).toThrow('Invalid agent action');
  await invoke(owner, mainFrame, 'start');
  expect(calls).toBe(1);
  const open = (sender: unknown, frame: unknown) => handlers.get(AGENT_TERMINAL_CHANNELS.open)!(
    { sender, senderFrame: frame } as IpcMainInvokeEvent, 'docker:colima-cheshi', 'worker');
  expect(() => open({}, mainFrame)).toThrow('workspace window');
  expect(() => open(owner, {})).toThrow('workspace window');
  expect(terminalCalls).toBe(0);
  await open(owner, mainFrame);
  expect(terminalCalls).toBe(1);
  const remove = handlers.get(AGENT_CHANNELS.remove)!;
  const deletion = { engineId: 'docker:local', containerId: 'a'.repeat(64), deleteData: false };
  const event = { sender: owner, senderFrame: mainFrame } as IpcMainInvokeEvent;
  expect(() => remove({ ...event, sender: {} } as IpcMainInvokeEvent, deletion)).toThrow('workspace window');
  expect(() => remove({ ...event, senderFrame: {} } as IpcMainInvokeEvent, deletion)).toThrow('workspace window');
  expect(() => remove(event, { ...deletion, deleteData: 'true' })).toThrow('flag');
  const bridge = createAgentManagementApi({ invoke: async (channel: string, value: unknown) => handlers.get(channel)!(event, value) });
  await bridge.remove!(deletion);
  expect(removals).toEqual([deletion]);
  events.emit('closed');
  expect(handlers.size).toBe(0);
  expect(terminalDisposed).toBe(true);
  registration.dispose();
  expect(() => remove(event, deletion)).toThrow('workspace window');
});

test('preload validates literal booleans instead of trusting IPC response truthiness', async () => {
  expect(() => parseAgentSnapshot({ engineId: 'docker:local', online: 'true', agents: [], error: null })).toThrow('flag');
  const api = createAgentManagementApi({ invoke: async () => ({ engines: [], error: null, secret: 'drop-this' }) });
  expect(await api.engines()).toEqual({ engines: [], error: null });
});

test('packaged runtime includes all agent modules and native Node can load them', async () => {
  const ignore = (await config()).packagerConfig?.ignore;
  if (typeof ignore !== 'function') throw new Error('Expected package filter');
  const paths = ['desktop/shared/agent-avatar.ts', 'desktop/shared/agent-management.ts', 'desktop/shared/agent-terminal.ts', 'desktop/lib/window-close-cleanup.mts',
    'desktop/shared/agent-registry.ts', 'desktop/shared/agent-models.ts', 'desktop/shared/agent-runtime.ts', 'desktop/shared/codex-accounts.ts',
    ...['engine', 'docker', 'docker-errors', 'service', 'ipc', 'terminal', 'registry', 'registry-ipc', 'runtime', 'instruction-files', 'operations', 'docker-deletion', 'deletion'].map(name => `desktop/lib/agent-management/${name}.mts`)];
  for (const path of paths) expect(ignore(`/${path}`)).toBe(false);
  expect(ignore('/desktop/lib/agent-management/local-secret.json')).toBe(true);
  const source = paths.map(path => `await import(${JSON.stringify(`./${path}`)});`).join('\n');
  execFileSync('node', ['--input-type=module', '-e', source], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 15_000 });
});

test('packaged specialist context includes its runtime dependencies without experiment fixtures', async () => {
  const { prepareSpecialistWorker, SPECIALIST_WORKER_FILES } = await import('../../scripts/prepare-specialist-worker.mts');
  const { mkdtemp, readFile, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-worker-assets-'));
  try {
    await prepareSpecialistWorker(fileURLToPath(new URL('../../experiments/codex-specialists', import.meta.url)), directory);
    for (const filename of SPECIALIST_WORKER_FILES) expect((await readFile(join(directory, filename))).byteLength).toBeGreaterThan(0);
    expect(await readdir(directory)).not.toContain('fixtures');
    expect((await readdir(join(directory, 'src'))).some(name => name.endsWith('.test.ts'))).toBe(false);
    // A staged worker must import all transitive verification modules without a TS transform.
    execFileSync('node', ['--input-type=module', '-e', "await import('./src/agent.ts'); await import('./src/verification.ts');"], { cwd: directory, timeout: 15_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
