import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
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
  let selection: string | null = null, delay = false;
  const registration = registerAgentRegistryIpc({ window, registry, workspaceRoot: directory,
    selectPackage: () => delay ? pending.promise : Promise.resolve(selection),
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
  const renderer = new EventEmitter();
  const api = createAgentRegistryApi(Object.assign(renderer, {
    invoke: async (channel: string, value?: unknown) => handlers.get(channel)!(event, value),
  }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  try {
    expect((await api.packages!()).map(value => value.id)).toEqual(['cheshi.development', 'cheshi.review']);
    const handler = handlers.get(AGENT_REGISTRY_CHANNELS.importPackage)!;
    expect(() => handler({ ...event, sender: {} } as IpcMainInvokeEvent)).toThrow('workspace window');
    expect(() => handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow('workspace window');
    expect(await api.importPackage!()).toBeNull();
    // Renderer arguments cannot replace the native dialog's selected path.
    expect(await handler(event, { path: '/unselected/agent.json' })).toBeNull();
    selection = resolve('resources/agent-packages/cheshi-review/agent.json');
    expect((await api.importPackage!())?.id).toBe('cheshi.review');
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
