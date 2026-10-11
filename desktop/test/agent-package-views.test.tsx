import { expect, test } from 'bun:test';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import type { SaveSpecialistAgent } from '../shared/agent-registry';
import type { CodexAccountsApi } from '../shared/codex-accounts';
import { specialistAgent, specialistModels } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const accounts: Pick<CodexAccountsApi, 'list' | 'onDidChange'> = {
  list: async () => ({ activeId: 'default', profiles: ['default', 'compatible'].map(id => ({ id, label: id, email: `${id}@example.test`,
    login: { state: 'signed_in' as const, error: null }, usage: { state: 'ready' as const, authenticated: true, plan: null, rateLimits: [], error: null } })) }),
  onDidChange: () => () => {},
};

test('imported file definitions preserve model requirements and separate requested from granted permissions', async () => {
  const [definition] = await officialAgentPackages();
  const saves: SaveSpecialistAgent[] = [];
  const supported = { ...specialistModels()[0]!, model: definition!.model.model! };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }),
    models: async id => id === 'compatible' ? [supported] : [], onDidChange: () => () => {},
    save: async input => { saves.push(input); const agent = { ...specialistAgent(), ...input.profile };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } });
  await model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<SpecialistAgentForm initialPackage={definition} model={model} state={model.snapshot()} accountsApi={accounts} />);
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await ui.click('Agent account'); await ui.click('default');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await ui.click('Agent account'); await ui.click('compatible');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await ui.click('Allow agent file changes'); await ui.click('Create agent');
    expect(saves[0]?.profile.accountId).toBe('compatible');
    expect(saves[0]?.profile.model).toBe(definition!.model.model);
    expect(saves[0]?.assignment.permissions).toEqual({ fileWrite: false, commandExecution: true });
    expect(saves[0]?.profile.package?.requestedPermissions.fileWrite).toBe(true);
  }); } finally { model.dispose(); }
});

test('creating a Homie from an imported package does not require reentering instructions or assets', async () => {
  const [, original] = await officialAgentPackages();
  const definition = { ...original!, model: { model: null, reasoningEffort: null, serviceTier: null } };
  const saves: SaveSpecialistAgent[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], onDidChange: () => () => {},
    save: async input => { saves.push(input); const agent = { ...specialistAgent(), ...input.profile };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } });
  await model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<SpecialistAgentForm initialPackage={definition} model={model} state={model.snapshot()} />);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe(definition.name);
    expect(document.querySelector('[aria-label="Agent instructions"]')).toBeNull();
    expect(saves).toHaveLength(0);
    await ui.click('Create agent');
    expect(saves[0]?.profile.package).toEqual(definition);
    expect(saves[0]?.profile.permissions).toEqual({ fileWrite: false, commandExecution: false });
    expect(saves[0]?.assignment.permissions).toEqual({ fileWrite: false, commandExecution: true });
  }); } finally { model.dispose(); }
});
