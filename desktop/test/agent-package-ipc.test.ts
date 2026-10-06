import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';
import { AGENT_REGISTRY_CHANNELS } from '../shared/agent-registry.ts';
import { registryDeferred } from './agent-registry-fixtures.ts';

test('package IPC only accepts native selections from its owner and handles cancellation and closed windows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-package-ipc-'));
  const registry = createAgentRegistry(join(directory, 'registry.json'));
  const owner = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const pending = registryDeferred<string | null>();
  const toolCalls: unknown[] = [];
  let selection: string | null = null, delay = false;
  let exportPath: string | null = null;
  const linked = join(directory, 'common.md');
  writeFileSync(linked, 'Common portable rules.');
  const registration = registerAgentRegistryIpc({ window, registry, workspaceRoot: directory,
    toolCredential: async input => { toolCalls.push(input); return true; },
    testTool: async input => { toolCalls.push(input); return { result: 'ok' }; },
    selectInstructionFiles: async () => [linked],
    packsDirectory: join(directory, 'packs'), exportPackagePath: async () => exportPath,
    selectPackage: () => delay ? pending.promise : Promise.resolve(selection),
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
  const renderer = new EventEmitter();
  const api = createAgentRegistryApi(Object.assign(renderer, {
    invoke: async (channel: string, value?: unknown) => handlers.get(channel)!(event, value),
  }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  try {
    expect(await api.toolCredential!({ action: 'save', origin: 'https://api.example.com', name: 'external', value: 'fixture-secret' })).toBe(true);
    expect(await api.testTool!({ agentId: '11111111-1111-1111-1111-111111111111', engineId: 'docker:test', tool: 'external', args: {} })).toEqual({ result: 'ok' });
    expect(toolCalls).toHaveLength(2);
    expect((await api.packages!()).map(value => value.id)).toEqual(['cheshi.development', 'cheshi.review']);
    const handler = handlers.get(AGENT_REGISTRY_CHANNELS.importPackage)!;
    expect(() => handler({ ...event, sender: {} } as IpcMainInvokeEvent)).toThrow('workspace window');
    expect(() => handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow('workspace window');
    expect(await api.importPackage!()).toBeNull();
    // Renderer arguments cannot replace the native dialog's selected path.
    expect(await handler(event, { path: '/unselected/agent.json' })).toBeNull();
    selection = resolve('resources/agent-packages/cheshi-review/agent.json');
    const imported = (await api.importPackage!())!;
    expect(imported.id).toBe('cheshi.review');
    const customized = { ...imported, id: 'test.review', resources: { files: [{ path: 'scripts/check.ts', content: 'export {};' }], programs: ['jq'] } };
    expect(await api.installPackage!(customized)).toEqual(customized);
    expect((await api.packages!()).some(pack => pack.id === 'test.review')).toBe(true);
    expect(await api.exportPackage!(customized)).toBe(false);
    exportPath = join(directory, 'export.homiepack.json');
    expect(await api.exportPackage!(customized)).toBe(true);
    selection = exportPath;
    expect(await api.importPackage!()).toEqual(customized);
    let blocked: unknown;
    try { await api.exportPackage!(customized, [linked]); } catch (error) { blocked = error; }
    expect((blocked as Error).message).toContain('Select or link');
    expect(await api.selectInstructionFiles!()).toEqual([linked]);
    expect(await api.exportPackage!(customized, [linked])).toBe(true);
    const portable = (await api.importPackage!())!;
    expect(portable.resources!.files.some(file => file.content === 'Common portable rules.')).toBe(true);
    expect(portable.instructions).toContain('/opt/cheshi/homie-pack/resources/instructions/');
    expect(JSON.stringify(portable)).not.toContain(directory);
    for (const channel of [AGENT_REGISTRY_CHANNELS.installPackage, AGENT_REGISTRY_CHANNELS.exportPackage, AGENT_REGISTRY_CHANNELS.toolCredential, AGENT_REGISTRY_CHANNELS.testTool]) {
      expect(() => handlers.get(channel)!({ ...event, sender: {} } as IpcMainInvokeEvent, customized)).toThrow('workspace window');
    }
    expect(registry.snapshot(directory).agents).toEqual([]);
    delay = true;
    const operation = api.importPackage!();
    window.emit('closed'); pending.resolve(selection);
    let error: unknown;
    try { await operation; } catch (reason) { error = reason; }
    expect((error as Error).message).toContain('closed');
    expect(handlers.size).toBe(0);
  } finally { registration.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
