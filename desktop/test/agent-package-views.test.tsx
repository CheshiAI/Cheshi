import { expect, test } from 'bun:test';
import { act } from 'react';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { officialAgentPackages } from '../lib/agent-management/packages.mts';
import type { AgentRegistryApi, SaveSpecialistAgent } from '../shared/agent-registry';
import { specialistAgent, specialistModels, registryDeferred } from './agent-registry-fixtures';
import type { CodexAccountsApi } from '../shared/codex-accounts';
import { withDOM } from './agent-chats-test-dom';

const field = (name: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`)!;

test('package model defaults require a local compatible account and permission requests remain editable', async () => {
  const [definition] = await officialAgentPackages();
  let saved: SaveSpecialistAgent | undefined;
  const supported = { ...specialistModels()[0]!, model: definition!.model.model! };
  const accounts: Pick<CodexAccountsApi, 'list' | 'onDidChange'> = {
    list: async () => ({ activeId: 'default', profiles: ['default', 'compatible'].map(id => ({ id, label: id, email: `${id}@example.test`,
      login: { state: 'signed_in' as const, error: null }, usage: { state: 'ready' as const, authenticated: true, plan: null, rateLimits: [], error: null } })) }),
    onDidChange: () => () => {},
  };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), installPackage: async value => value, packages: async () => [definition!],
    importPackage: async () => definition!, models: async id => id === 'compatible' ? [supported] : [], onDidChange: () => () => {},
    save: async input => { saved = input; const agent = { ...specialistAgent(), ...input.profile };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } });
  await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistAgentForm model={model} state={model.snapshot()} accountsApi={accounts} />);
      await ui.click('Import Homie pack…'); await ui.click('Load package into draft');
      const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(submit().disabled).toBe(true);
      await ui.click('Agent account'); await ui.click('default@example.test');
      expect(submit().disabled).toBe(true);
      await ui.click('Agent account'); await ui.click('compatible@example.test');
      expect(submit().disabled).toBe(false);
      await ui.click('Allow agent file changes'); await ui.click('Create agent');
      expect(saved!.profile.accountId).toBe('compatible');
      expect(saved!.profile.model).toBe(definition!.model.model);
      expect(saved!.profile.reasoningEffort).toBe('medium');
      expect(saved!.assignment.permissions).toEqual({ fileWrite: false, commandExecution: true });
      expect(saved!.profile.package!.requestedPermissions.fileWrite).toBe(true);
    });
  } finally { model.dispose(); }
});

test('package import only changes a draft after review and saves a self-contained snapshot with project permissions', async () => {
  const definitions = await officialAgentPackages();
  const definition = { ...definitions[1]!, model: { model: null, reasoningEffort: null, serviceTier: null } };
  let saved: SaveSpecialistAgent | undefined;
  const api: AgentRegistryApi = { list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [],
    installPackage: async value => value, packages: async () => [definition], importPackage: async () => definition, onDidChange: () => () => {},
    save: async input => { saved = input; const agent = { ...specialistAgent(), ...input.profile, assignments: [] };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } }; } };
  const model = new AgentRegistryModel(api); await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistAgentForm model={model} state={model.snapshot()} />);
      await ui.type('Agent name', 'My draft');
      await ui.click('Import Homie pack…');
      expect(field('Agent name').value).toBe('My draft'); expect(saved).toBeUndefined();
      expect(document.querySelector('[aria-label="Package preview"]')).not.toBeNull();
      await ui.click('Cancel package preview'); expect(field('Agent name').value).toBe('My draft');
      await ui.click('Official agent package');
      await ui.click(`${definition.name} · ${definition.version}`);
      await ui.click('Load package into draft');
      expect(field('Agent name').value).toBe(definition.name);
      expect(field('Agent instructions').value).toBe(definition.instructions);
      expect(document.querySelector('[aria-label="Allow agent file changes"]')?.getAttribute('aria-checked')).toBe('false');
      expect(document.querySelector('[aria-label="Allow agent commands"]')?.getAttribute('aria-checked')).toBe('true');
      expect(saved).toBeUndefined();
      await ui.click('Create agent');
      expect(saved!.profile.package).toEqual(definition);
      expect(saved!.profile.accountId).toBeNull();
      expect(saved!.profile.permissions).toEqual({ fileWrite: false, commandExecution: false });
      expect(saved!.assignment.permissions).toEqual({ fileWrite: false, commandExecution: true });
    });
  } finally { model.dispose(); }
});

test('updates preserve customized instructions and local settings until the user chooses replacement', async () => {
  const definitions = await officialAgentPackages(), definition = definitions[0]!;
  const agent = { ...specialistAgent(), package: definition, instructions: 'Locally customized', name: 'My Homie',
    assignments: [{ workspaceRoot: '/project', instructions: 'Project-only rules', permissions: { fileWrite: false, commandExecution: false } }] };
  const update = { ...definition, version: '1.1.0', instructions: 'Updated rules' };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], installPackage: async value => value, packages: async () => [], importPackage: async () => update,
    save: async () => { throw Error('Must stay a draft'); }, onDidChange: () => () => {} });
  await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistAgentForm agent={agent} model={model} state={model.snapshot()} />);
      await ui.click('Import Homie pack…');
      expect(field('Current package instructions').value).toBe('Locally customized');
      expect(field('Package instructions preview').value).toBe('Updated rules');
      expect(document.querySelector('[aria-label="Keep current instructions"]')?.getAttribute('aria-checked')).toBe('true');
      await ui.click('Apply package update to draft');
      expect(field('Agent instructions').value).toBe('Locally customized');
      expect(field('Agent name').value).toBe('My Homie');
      expect(field('Project instructions').value).toBe('Project-only rules');
      expect(document.body.textContent).toContain('Customized instructions');
      await ui.click('Import Homie pack…'); await ui.click('Keep current instructions');
      await ui.click('Apply package update to draft');
      expect(field('Agent instructions').value).toBe('Updated rules');
      expect(document.querySelector('[aria-label="Allow agent commands"]')?.getAttribute('aria-checked')).toBe('false');
    });
  } finally { model.dispose(); }
});

test('cancelled and failed imports preserve drafts and late results after unmount are ignored', async () => {
  const deferred = registryDeferred<null>();
  let mode = 'cancel';
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [] }), models: async () => [],
    installPackage: async value => value, packages: async () => [], importPackage: async () => { if (mode === 'fail') throw Error('Invalid package'); return mode === 'pending' ? deferred.promise : null; },
    save: async () => { throw Error('unused'); }, onDidChange: () => () => {} });
  await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistAgentForm model={model} state={model.snapshot()} />);
      await ui.type('Agent name', 'Keep draft');
      await ui.click('Import Homie pack…'); expect(field('Agent name').value).toBe('Keep draft');
      mode = 'fail'; await ui.click('Import Homie pack…');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid package');
      expect(field('Agent name').value).toBe('Keep draft');
      mode = 'pending'; await ui.click('Import Homie pack…');
      expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      await ui.render(null); await act(async () => deferred.resolve(null));
      expect(document.querySelector('form')).toBeNull();
    });
  } finally { model.dispose(); }
});
