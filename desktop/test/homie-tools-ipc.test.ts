import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { createAgentRegistry } from '../lib/agent-management/registry.mts';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';
import { AGENT_REGISTRY_CHANNELS } from '../shared/agent-registry.ts';
import { registryDeferred } from './agent-registry-fixtures.ts';
import { portableAgent } from '../lib/agent-management/homie-source-files.mts';
import { specialistAgent } from './agent-registry-fixtures.ts';

test('Homie tools and repository previews reject foreign frames and closed windows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-package-ipc-'));
  const registry = createAgentRegistry(join(directory, 'registry.json'));
  const owner = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const pending = registryDeferred<import('../shared/homie-repository-connection').HomieRepositoryPreview>();
  const toolCalls: unknown[] = [];
  let delay = false;
  const linked = join(directory, 'common.md');
  writeFileSync(linked, 'Common portable rules.');
  const registration = registerAgentRegistryIpc({ window, registry, workspaceRoot: directory,
    toolCredential: async input => { toolCalls.push(input); return true; },
    testTool: async input => { toolCalls.push(input); return { result: 'ok' }; },
    hostTool: async input => { toolCalls.push(input); return { allowed: input.action === 'allow', executable: null, digest: null,
      ...(input.action === 'policy' ? { autoApprove: input.autoApprove ?? false } : {}) }; },
    selectInstructionFiles: async () => [linked],
    previewRepository: () => delay ? pending.promise : Promise.reject(new Error('Repository unavailable')),
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } } });
  const renderer = new EventEmitter();
  const api = createAgentRegistryApi(Object.assign(renderer, {
    invoke: async (channel: string, value?: unknown) => handlers.get(channel)!(event, value),
  }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  try {
    expect(await api.toolCredential!({ action: 'save', origin: 'https://api.example.com', name: 'external', value: 'fixture-secret' })).toBe(true);
    expect(await api.testTool!({ agentId: '11111111-1111-1111-1111-111111111111', engineId: 'docker:test', tool: 'external', args: {} })).toEqual({ result: 'ok' });
    expect(toolCalls).toHaveLength(2);
    expect(await api.hostTool!({ action: 'allow', agentId: 'fixture', tool: 'fixture' })).toEqual({ allowed: true, executable: null, digest: null });
    expect(await api.hostTool!({ action: 'revoke', agentId: 'fixture', tool: 'fixture' })).toEqual({ allowed: false, executable: null, digest: null });
    expect(await api.hostTool!({ action: 'policy', agentId: 'fixture', tool: 'fixture', autoApprove: true }))
      .toEqual({ allowed: false, executable: null, digest: null, autoApprove: true });
    expect(() => handlers.get(AGENT_REGISTRY_CHANNELS.hostTool)!(event,
      { action: 'policy', agentId: 'fixture', tool: 'fixture', autoApprove: 'true' })).toThrow('Invalid');
    for (const obsolete of ['import-package', 'export-package', 'install-package', 'packages']) {
      expect(handlers.has(`cheshi:agent-registry:${obsolete}`)).toBe(false);
    }
    expect(await api.selectInstructionFiles!()).toEqual([linked]);
    for (const channel of [AGENT_REGISTRY_CHANNELS.hostTool, AGENT_REGISTRY_CHANNELS.previewRepository, AGENT_REGISTRY_CHANNELS.toolCredential, AGENT_REGISTRY_CHANNELS.testTool]) {
      expect(() => handlers.get(channel)!({ ...event, sender: {} } as IpcMainInvokeEvent, {})).toThrow('workspace window');
      expect(() => handlers.get(channel)!({ ...event, senderFrame: {} } as IpcMainInvokeEvent, {})).toThrow('workspace window');
    }
    expect(registry.snapshot(directory).agents).toEqual([]);
    delay = true;
    const operation = api.previewRepository!('CheshiAI/Homie-atlas');
    window.emit('closed'); pending.resolve({ repository: 'CheshiAI/Homie-atlas', directory, hash: 'a'.repeat(64), definition: portableAgent(specialistAgent()) });
    let error: unknown;
    try { await operation; } catch (reason) { error = reason; }
    expect((error as Error).message).toContain('closed');
    expect(handlers.size).toBe(0);
  } finally { registration.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
