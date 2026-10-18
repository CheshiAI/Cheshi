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

test('GitHub connection preserves repository configuration and requires explicit grants', async () => {
  const [definition] = await officialAgentPackages();
  const saves: SaveSpecialistAgent[] = [];
  const supported = { ...specialistModels()[0]!, model: definition!.model.model! };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }),
    previewRepository: async () => ({ repository: 'CheshiAI/Homie-atlas', directory: '/projects/homie-atlas', hash: 'a'.repeat(64), definition: definition! }),
    models: async id => id === 'compatible' ? [supported] : [], onDidChange: () => () => {},
    save: async input => { saves.push(input); const agent = { ...specialistAgent(), ...input.profile };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } });
  await model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<SpecialistAgentForm model={model} state={model.snapshot()} accountsApi={accounts} />);
    await ui.click('Homie source'); await ui.click('Connect an existing GitHub Homie');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await ui.type('Homie GitHub repository', 'https://github.com/CheshiAI/Homie-atlas'); await ui.click('Check repository');
    await ui.click('Agent account'); await ui.click('default');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await ui.click('Agent account'); await ui.click('compatible');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await ui.click('Allow agent commands'); await ui.click('Connect Homie');
    expect(saves[0]?.profile.accountId).toBe('compatible');
    expect(saves[0]?.profile.model).toBe(definition!.model.model);
    expect(saves[0]?.assignment.permissions).toEqual({ fileWrite: false, commandExecution: true });
    expect(saves[0]?.profile.package?.requestedPermissions.fileWrite).toBe(true);
  }); } finally { model.dispose(); }
});

test('GitHub connection can defer account setup and blocks saving an unchecked URL', async () => {
  const [, original] = await officialAgentPackages();
  const definition = { ...original!, model: { model: null, reasoningEffort: null, serviceTier: null } };
  const saves: SaveSpecialistAgent[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], previewRepository: async () => ({ repository: 'CheshiAI/Homie-atlas', directory: '/projects/homie-atlas', hash: 'a'.repeat(64), definition }), onDidChange: () => () => {},
    save: async input => { saves.push(input); const agent = { ...specialistAgent(), ...input.profile };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } });
  await model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<SpecialistAgentForm model={model} state={model.snapshot()} />);
    await ui.click('Homie source'); await ui.click('Connect an existing GitHub Homie');
    await ui.type('Homie GitHub repository', 'CheshiAI/Homie-atlas'); await ui.click('Check repository');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe(definition.name);
    expect(document.querySelector('[aria-label="Agent instructions"]')).toBeNull();
    expect(saves).toHaveLength(0);
    await ui.click('Connect Homie');
    expect(saves[0]?.profile.package).toEqual(definition);
    expect(saves[0]?.profile.permissions).toEqual({ fileWrite: false, commandExecution: false });
    expect(saves[0]?.assignment.permissions).toEqual({ fileWrite: false, commandExecution: false });
    expect(saves[0]?.repository).toEqual({ repository: 'CheshiAI/Homie-atlas', hash: 'a'.repeat(64) });
    await ui.type('Homie GitHub repository', 'CheshiAI/Another');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  }); } finally { model.dispose(); }
});
