import { expect, test } from 'bun:test';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { AgentRegistryApi, AgentRegistrySnapshot } from '../shared/agent-registry';
import { registryDeferred, specialistAgent, specialistInput } from './agent-registry-fixtures';

function fixture(overrides: Partial<AgentRegistryApi> = {}) {
  let notify: (value: AgentRegistrySnapshot) => void = () => {};
  let unsubscribed = false;
  const empty = { workspaceRoot: '/projects/one', agents: [] };
  const model = new AgentRegistryModel({ list: async () => empty, models: async () => [],
    save: async () => ({ agentId: specialistAgent().id, snapshot: { ...empty, agents: [specialistAgent()] } }),
    onDidChange: listener => { notify = listener; return () => { unsubscribed = true; }; }, ...overrides });
  return { model, notify: (value: AgentRegistrySnapshot) => notify(value), unsubscribed: () => unsubscribed };
}

test('global registry notifications supersede pending reads without losing the editor selection', async () => {
  const pending = registryDeferred<AgentRegistrySnapshot>();
  const f = fixture({ list: () => pending.promise });
  try {
    const refreshing = f.model.refresh();
    f.model.select('new');
    f.notify({ workspaceRoot: '/projects/one', agents: [specialistAgent()] });
    pending.resolve({ workspaceRoot: '/projects/one', agents: [] });
    await refreshing;
    expect(f.model.snapshot().data?.agents).toHaveLength(1);
    expect(f.model.snapshot().selection).toBe('new');
    expect(f.model.snapshot().loading).toBe(false);
  } finally { f.model.dispose(); }
  expect(f.unsubscribed()).toBe(true);
});

test('save acknowledgement selects a persistent agent without overwriting newer notifications', async () => {
  const pending = registryDeferred<Awaited<ReturnType<AgentRegistryApi['save']>>>();
  const f = fixture({ save: () => pending.promise });
  try {
    f.model.select('new');
    const saving = f.model.save(specialistInput());
    expect(f.model.snapshot().selection).toBe('new');
    expect(f.model.snapshot().saving).toBe(true);
    f.model.select(null);
    expect(f.model.snapshot().selection).toBe('new');
    f.notify({ workspaceRoot: '/projects/one', agents: [{ ...specialistAgent(2), name: 'Updated elsewhere' }] });
    pending.resolve({ agentId: specialistAgent().id, snapshot: { workspaceRoot: '/projects/one', agents: [specialistAgent()] } });
    await saving;
    expect(f.model.snapshot().selection).toBe(specialistAgent().id);
    expect(f.model.snapshot().data?.agents[0]?.name).toBe('Updated elsewhere');
    expect(f.model.snapshot().saving).toBe(false);
  } finally { f.model.dispose(); }
});

test('failed saves keep the creation screen and saved registry intact', async () => {
  const f = fixture({ save: async () => { throw new Error('Disk unavailable'); } });
  try {
    await f.model.refresh();
    f.model.select('new');
    let error: unknown;
    try { await f.model.save(specialistInput()); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(Error);
    expect(f.model.snapshot()).toMatchObject({ selection: 'new', saving: false, error: 'Disk unavailable', data: { agents: [] } });
  } finally { f.model.dispose(); }
});
