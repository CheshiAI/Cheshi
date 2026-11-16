import { expect, test } from 'bun:test';
import { defaultAgentAvatar } from '../shared/agent-avatar';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { assertAgentModelSelection, parseAgentModels, selectAgentModel } from '../shared/agent-models';
import { AGENT_REGISTRY_CHANNELS, parseSaveSpecialistAgent, parseSpecialistAgents } from '../shared/agent-registry';
import { registerAgentRegistryIpc } from '../lib/agent-management/registry-ipc.mts';
import { createAgentRegistryApi } from '../lib/agent-registry-preload.cts';
import { registryDeferred, specialistAgent, specialistInput, specialistModels } from './agent-registry-fixtures';

async function rejected(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test('model selection retains supported effort and resets incompatible effort and speed', () => {
  const models = specialistModels();
  const selected = { model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
  expect(selectAgentModel(selected, models[0])).toEqual(selected);
  expect(selectAgentModel(selected, models[1])).toEqual({ model: 'small-fixture', reasoningEffort: 'low', serviceTier: null });
  expect(() => assertAgentModelSelection({ ...selected, reasoningEffort: 'ultra' }, models)).toThrow('reasoning');
  expect(() => assertAgentModelSelection({ ...selected, serviceTier: 'unknown' }, models)).toThrow('service tier');
  expect(() => assertAgentModelSelection(selected, [])).toThrow('unavailable');
  expect(() => assertAgentModelSelection({ ...selected, model: null }, models)).toThrow('Select a model');
  expect(() => parseAgentModels([{ ...models[0], isDefault: 'true' }])).toThrow('flag');
  expect(() => parseAgentModels([{ ...models[0], supportedReasoningEfforts: [] }])).toThrow('Default reasoning');
});

test('saved model settings round trip and legacy profiles receive compatible defaults', () => {
  const agent = { ...specialistAgent(), model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
  expect(parseSpecialistAgents(JSON.parse(JSON.stringify([agent])))).toEqual([{ ...agent, avatar: defaultAgentAvatar(agent.id) }]);
  const { reasoningEffort: _effort, serviceTier: _tier, ...legacy } = agent;
  expect(parseSpecialistAgents([legacy])[0]).toMatchObject({ model: 'model-fixture', reasoningEffort: null, serviceTier: null });
  expect(() => parseSaveSpecialistAgent({ ...specialistInput(), profile: { ...agent, reasoningEffort: true } })).toThrow();
});

test('agent catalog IPC validates the account and model combination before saving and refuses late saves', async () => {
  const owner = { mainFrame: {}, isDestroyed: () => false, send() {} };
  const window = Object.assign(new EventEmitter(), { webContents: owner }) as unknown as BrowserWindow;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const calls: string[] = [];
  let saves = 0;
  const delayed = registryDeferred<ReturnType<typeof specialistModels>>();
  const registration = registerAgentRegistryIpc({ window, workspaceRoot: '/projects/one',
    ipc: { handle: (key, fn) => { handlers.set(key, fn); }, removeHandler: key => { handlers.delete(key); } },
    models: async id => { calls.push(id); return id === 'delayed' ? delayed.promise : specialistModels(); },
    registry: { subscribe: () => () => {}, snapshot: () => ({ workspaceRoot: '/projects/one', agents: [] }),
      save: () => { saves++; return { agentId: specialistAgent().id, snapshot: { workspaceRoot: '/projects/one', agents: [specialistAgent()] } }; } },
  });
  const renderer = new EventEmitter();
  const api = createAgentRegistryApi(Object.assign(renderer, {
    invoke: async (channel: string, value: unknown) => handlers.get(channel)!(event, value),
  }) as unknown as Parameters<typeof createAgentRegistryApi>[0]);
  const input = specialistInput();
  input.profile = { ...input.profile, accountId: 'chosen-account', model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' };
  try {
    expect(await api.models('chosen-account')).toEqual(specialistModels());
    await rejected(api.models('../invalid'), 'Invalid agent account');
    const catalog = handlers.get(AGENT_REGISTRY_CHANNELS.models)!;
    expect(() => catalog({ ...event, senderFrame: {} } as IpcMainInvokeEvent, 'chosen-account')).toThrow('workspace window');
    await api.save(input);
    expect(calls).toEqual(['chosen-account', 'chosen-account']);
    expect(saves).toBe(1);
    await rejected(api.save({ ...input, profile: { ...input.profile, reasoningEffort: 'ultra' } }), 'reasoning');
    await rejected(api.save({ ...input, profile: { ...input.profile, accountId: null } }), 'Invalid agent account');
    expect(saves).toBe(1);
    const pending = api.save({ ...input, profile: { ...input.profile, accountId: 'delayed' } });
    window.emit('closed');
    delayed.resolve(specialistModels());
    await rejected(pending, 'closed');
    expect(saves).toBe(1);
    expect(handlers.size).toBe(0);
  } finally { registration.dispose(); }
});
