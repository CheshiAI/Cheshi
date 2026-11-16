import { expect, test } from 'bun:test';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import type { SaveSpecialistAgent } from '../shared/agent-registry';
import type { CodexAccountsApi } from '../shared/codex-accounts';
import { specialistAgent, specialistModels } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';
import type { HomieEditorDraft } from '../frontend/src/features/agents/homieEditorDraft';

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
    repositoryLocation: async () => '/projects/homie-atlas', previewRepository: async () => ({ repository: 'CheshiAI/Homie-atlas', directory: '/projects/homie-atlas', hash: 'a'.repeat(64), definition: definition! }),
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
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [], repositoryLocation: async () => '/projects/homie-atlas', previewRepository: async () => ({ repository: 'CheshiAI/Homie-atlas', directory: '/projects/homie-atlas', hash: 'a'.repeat(64), definition }), onDidChange: () => () => {},
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
    expect(saves[0]?.repository).toEqual({ repository: 'CheshiAI/Homie-atlas', directory: '/projects/homie-atlas', hash: 'a'.repeat(64) });
    await ui.type('Homie GitHub repository', 'CheshiAI/Another');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  }); } finally { model.dispose(); }
});

test('save location selection, cancellation and manual edits preserve drafts and invalidate reviewed checkouts', async () => {
  const [definition] = await officialAgentPackages();
  const saves: SaveSpecialistAgent[] = [], checks: string[] = [];
  let cancel = true;
  let draft: HomieEditorDraft | undefined;
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }),
    repositoryLocation: async input => input.choose ? (cancel ? null : '/chosen parent/homie-atlas') : '/default/homie-atlas',
    previewRepository: async (repository, directory) => {
      checks.push(directory!);
      return { repository, directory: directory!, hash: 'a'.repeat(64), definition: definition! };
    },
    models: async () => [], onDidChange: () => () => {},
    save: async input => { saves.push(input); const agent = { ...specialistAgent(), ...input.profile };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } });
  await model.refresh();
  try { await withDOM(async ui => {
    const saveLocation = () => document.querySelector<HTMLInputElement>('[aria-label="Homie repository save location"]')!.value;
    const blocked = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled;
    const capture = (value: HomieEditorDraft) => { draft = value; };
    await ui.render(<SpecialistAgentForm model={model} state={model.snapshot()} onDraft={capture} />);
    await ui.click('Homie source'); await ui.click('Connect an existing GitHub Homie');
    await ui.type('Homie GitHub repository', 'CheshiAI/Homie-atlas');
    expect(saveLocation()).toBe('/default/homie-atlas');
    await ui.click('Check repository');
    expect(blocked()).toBe(false);
    await ui.click('Choose parent folder');
    expect(saveLocation()).toBe('/default/homie-atlas');
    expect(blocked()).toBe(false);
    cancel = false; await ui.click('Choose parent folder');
    expect(saveLocation()).toBe('/chosen parent/homie-atlas');
    expect(blocked()).toBe(true);
    await ui.click('Check repository');
    expect(checks).toEqual(['/default/homie-atlas', '/chosen parent/homie-atlas']);
    await ui.type('Homie repository save location', '/manual/atlas');
    expect(blocked()).toBe(true);
    expect(draft?.repositoryDirectory).toBe('/manual/atlas');
    expect(draft?.repositoryPreview).toBeUndefined();
    await ui.render(<SpecialistAgentForm key="restored" model={model} state={model.snapshot()} draft={draft} onDraft={capture} />);
    expect(saveLocation()).toBe('/manual/atlas');
    await ui.click('Check repository'); await ui.click('Connect Homie');
    expect(saves[0]?.repository?.directory).toBe('/manual/atlas');
    await ui.type('Homie GitHub repository', 'CheshiAI/Another');
    expect(blocked()).toBe(true);
    expect(draft?.repositoryDirectory).toBeUndefined();
  }); } finally { model.dispose(); }
});
