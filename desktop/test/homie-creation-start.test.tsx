import { expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { SpecialistRuntimePanel } from '../frontend/src/features/agents/SpecialistRuntimePanel';
import { createHomiePack } from '../frontend/src/features/agents/homiePackAuthoring';
import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent } from '../shared/agent-registry';
import type { AgentRuntimeRequest, AgentRuntimeState } from '../shared/agent-runtime';
import { registryDeferred, specialistAgent, specialistInput, specialistModels } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const workspaceRoot = '/projects/one';
const engineId = 'docker:local';
const ready: AgentRuntimeState = { details: {
  agent: { id: 'worker', name: 'Development', image: 'worker', state: 'running' },
  ready: true, busy: false, authenticated: true, threadId: null, error: null, logs: '', tasks: [],
} };

function creationInput(): SaveSpecialistAgent {
  const input = specialistInput();
  return { ...input, profile: { ...input.profile, accountId: 'default' } };
}

function fixture(options: { beforeSave?(): Promise<void>; runtime?: AgentRegistryApi['runtime']; repositoryError?: string } = {}) {
  const saves: SaveSpecialistAgent[] = [], requests: AgentRuntimeRequest[] = [];
  let data: AgentRegistrySnapshot = { workspaceRoot, agents: [] };
  const model = new AgentRegistryModel({
    list: async () => data, models: async () => specialistModels(), onDidChange: () => () => {},
    save: async input => {
      saves.push(input);
      await options.beforeSave?.();
      const agent = { ...specialistAgent(), ...input.profile, id: input.id ?? specialistAgent().id,
        revision: (input.revision ?? 0) + 1,
        assignments: input.assignment.assigned ? [{ workspaceRoot, instructions: input.assignment.instructions }] : [] };
      data = { workspaceRoot, agents: [agent] };
      return { agentId: agent.id, snapshot: data, repositoryError: options.repositoryError };
    },
    runtime: async request => { requests.push(request); return options.runtime ? options.runtime(request) : ready; },
  });
  model.select('new');
  return { model, saves, requests };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test('creation waits for persistence, starts the saved ID once and prevents duplicate creation during preparation', async () => {
  const persisted = registryDeferred<void>(), starting = registryDeferred<void>(), running = registryDeferred<AgentRuntimeState>();
  const f = fixture({ beforeSave: () => persisted.promise, runtime: async () => { starting.resolve(); return running.promise; } });
  try {
    const saving = f.model.save(creationInput(), engineId);
    expect(f.requests).toHaveLength(0);
    persisted.resolve(); await starting.promise;
    expect(f.requests).toEqual([{ action: 'start', agentId: specialistAgent().id, engineId }]);
    expect(f.model.snapshot()).toMatchObject({ selection: 'new', saving: true, starting: true });
    expect(f.model.snapshot().data?.agents).toHaveLength(1);
    f.model.select(null);
    expect(f.model.snapshot().selection).toBe('new');
    await expectFailure(f.model.save(creationInput(), engineId), 'already in progress');
    running.resolve(ready);
    const agent = await saving;
    expect(f.model.snapshot()).toMatchObject({ selection: agent.id, saving: false, starting: false, error: null });
    expect(f.saves).toHaveLength(1);
    await f.model.save({ ...creationInput(), id: agent.id, revision: agent.revision }, engineId);
    expect(f.saves).toHaveLength(2);
    expect(f.requests).toHaveLength(1);
  } finally { f.model.dispose(); }
});

test('a persistence failure does not start a worker or leave creation mode', async () => {
  const f = fixture({ beforeSave: async () => { throw new Error('Disk unavailable'); } });
  try {
    await f.model.refresh();
    await expectFailure(f.model.save(creationInput(), engineId), 'Disk unavailable');
    expect(f.requests).toHaveLength(0);
    expect(f.model.snapshot()).toMatchObject({ selection: 'new', saving: false, starting: false, data: { agents: [] } });
  } finally { f.model.dispose(); }
});

test('repository preparation failure keeps the saved ID selected and never starts Docker', async () => {
  const f = fixture({ repositoryError: 'GitHub is unavailable' });
  try {
    const agent = await f.model.save(creationInput(), engineId);
    expect(f.model.snapshot()).toMatchObject({ selection: agent.id, saving: false, starting: false });
    expect(f.model.snapshot().error).toContain('GitHub repository is not ready. GitHub is unavailable');
    expect(f.model.snapshot().data?.agents).toHaveLength(1);
    expect(f.requests).toHaveLength(0);
  } finally { f.model.dispose(); }
});

test('startup failure preserves the saved Homie and manual retry starts the same ID without saving again', async () => {
  let fail = true;
  const f = fixture({ runtime: async () => { if (fail) throw new Error('Docker disconnected'); return ready; } });
  try {
    const agent = await f.model.save(creationInput(), engineId);
    expect(f.model.snapshot()).toMatchObject({ selection: agent.id, saving: false, starting: false });
    expect(f.model.snapshot().error).toContain('Homie saved, but its worker did not start. Docker disconnected');
    expect(f.model.snapshot().data?.agents).toHaveLength(1);
    fail = false;
    await f.model.runtime({ action: 'start', agentId: agent.id, engineId });
    expect(f.model.snapshot().error).toBeNull();
    expect(f.saves).toHaveLength(1);
    expect(f.requests.map(request => request.agentId)).toEqual([agent.id, agent.id]);
  } finally { f.model.dispose(); }
});

test('missing account, project assignment or Docker engine keeps the profile and explains the next step', async () => {
  const missingAccount = creationInput(); missingAccount.profile.accountId = null;
  const unassigned = creationInput(); unassigned.assignment.assigned = false;
  const cases = [
    { input: missingAccount, engine: engineId, reason: 'Choose an account' },
    { input: unassigned, engine: engineId, reason: 'Assign this Homie' },
    { input: creationInput(), engine: null, reason: 'Choose a Docker execution engine' },
    { input: creationInput(), engine: 'remote:engine', reason: 'Choose a Docker execution engine' },
  ];
  for (const { input, engine, reason } of cases) {
    const f = fixture();
    try {
      const agent = await f.model.save(input, engine);
      expect(f.model.snapshot().selection).toBe(agent.id);
      expect(f.model.snapshot().error).toContain(reason);
      expect(f.requests).toHaveLength(0);
      expect(f.model.snapshot().data?.agents).toHaveLength(1);
    } finally { f.model.dispose(); }
  }
});

test('resolved unavailable, unhealthy and not-ready runtime responses are not reported as successful starts', async () => {
  const responses: AgentRuntimeState[] = [
    { details: null, unavailable: { kind: 'engine-unavailable', message: 'Engine offline' } },
    { ...ready, lifecycle: { phase: 'error', error: 'Startup interrupted' } },
    { details: { ...ready.details!, error: 'Authentication required' } },
    { details: null },
  ];
  for (const response of responses) {
    const f = fixture({ runtime: async () => response });
    try {
      const agent = await f.model.save(creationInput(), engineId);
      expect(f.model.snapshot().selection).toBe(agent.id);
      expect(f.model.snapshot().error).toContain('Homie saved, but its worker did not start.');
      expect(f.model.snapshot().saving).toBe(false);
    } finally { f.model.dispose(); }
  }
});

test('the creation form shows preparation, preserves a failed creation across remount and retries through Start agent', async () => {
  const pending = registryDeferred<AgentRuntimeState>();
  let attempts = 0;
  const f = fixture({ runtime: async request => {
    if (request.action !== 'start') return { details: null };
    return ++attempts === 1 ? pending.promise : ready;
  } });
  const profile = creationInput().profile;
  const draft = { profile, permissions: profile.permissions, revision: null, assigned: true, localPack: createHomiePack(profile, profile.permissions), section: 'basic' };
  function Editor() {
    const state = useSyncExternalStore(f.model.subscribe, f.model.snapshot);
    const agent = state.data?.agents.find(item => item.id === state.selection);
    return <SpecialistAgentForm key={agent?.id ?? 'new'} agent={agent} model={f.model} state={state} engineId={engineId}
      draft={agent ? undefined : draft}
      runtime={agent ? (headerTarget, disabled) => <SpecialistRuntimePanel agent={agent} model={f.model} assigned
        engineId={engineId} engines={[{ id: engineId, name: 'Local', supported: true, reason: null }]}
        disabled={disabled} headerTarget={headerTarget} /> : undefined} />;
  }
  try {
    await f.model.refresh();
    await withDOM(async ui => {
      await ui.render(<Editor />);
      await ui.type('Agent name', 'Automatic Homie');
      await ui.click('Create agent');
      expect(document.body.textContent).toContain('Homie saved. Preparing its environment');
      expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
      await ui.click('Preparing environment…');
      expect(f.saves).toHaveLength(1);
      expect(f.requests).toEqual([{ action: 'start', agentId: specialistAgent().id, engineId }]);
      await act(async () => pending.reject(new Error('Docker disconnected')));
      expect(document.querySelector('form[aria-label="Agent settings"]')).not.toBeNull();
      expect(document.querySelector('h2')?.textContent).toBe('Automatic Homie');
      expect(document.body.textContent).toContain('Homie saved, but its worker did not start. Docker disconnected');
      await ui.click('Start agent');
      expect(document.body.textContent).toContain('Ready');
      expect(document.body.textContent).not.toContain('Homie saved, but its worker did not start.');
      expect(f.saves).toHaveLength(1);
      expect(f.requests.filter(request => request.action === 'start')).toHaveLength(2);
      await ui.click('Save local settings');
      expect(f.saves).toHaveLength(2);
      expect(f.saves[1]?.id).toBe(specialistAgent().id);
      expect(f.requests.filter(request => request.action === 'start')).toHaveLength(2);
    });
  } finally { f.model.dispose(); }
});
