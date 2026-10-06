import { expect, test } from 'bun:test';
import { act } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import type { AgentManagementApi } from '../shared/agent-management';
import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent } from '../shared/agent-registry';
import { createHomiePack } from '../frontend/src/features/agents/homiePackAuthoring';

function fixture() {
  const first = specialistAgent();
  const second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Review' };
  let snapshot: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [first, second] };
  const saves: SaveSpecialistAgent[] = [];
  const registry: AgentRegistryApi = {
    list: async () => snapshot, models: async () => [], onDidChange: () => () => {},
    save: async input => {
      saves.push(input);
      const agent = { ...first, ...input.profile, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
      snapshot = { ...snapshot, agents: [...snapshot.agents, agent] };
      return { agentId: agent.id, snapshot };
    },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ engines: [], error: null }),
    snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
    details: async () => { throw Error('Navigation must not inspect unrelated workers'); },
    control: async () => { throw Error('Navigation must not control workers'); },
  };
  return { first, second, registry, api, saves };
}
const name = () => document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value;

test('Homie selection replaces the full list with settings and retains drafts when returning', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry} />);
    expect(document.querySelector('[aria-label="Agent selection"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Search Homies"]')).toBeNull();
    await ui.click(f.first.name); await ui.type('Agent name', 'Development draft');
    await ui.click('Instructions'); await ui.type('Agent instructions', 'Unsaved rules');
    expect(document.querySelector('[aria-label="Agent selection"]')).toBeNull();
    await ui.click('All Homies'); await ui.click(f.second.name);
    expect(name()).toBe(f.second.name);
    await ui.click('All Homies'); await ui.click(f.first.name);
    expect(name()).toBe('Development draft');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Agent instructions"]')?.value).toBe('Unsaved rules');
    expect(document.querySelector('[aria-label="Homie sections"] [aria-current="page"]')?.textContent).toBe('Instructions');
    await ui.click('Homie actions'); await ui.click('Duplicate Homie');
    expect(name()).toBe('Development draft (copy)');
    expect(f.saves).toHaveLength(0);
    await ui.click('Create agent');
    expect(f.saves).toHaveLength(1); expect(f.saves[0]!.id).toBeNull();
    expect(f.saves[0]!.profile.instructions).toBe('Unsaved rules');
    await ui.click('New agent'); expect(name()).toBe('');
    await ui.click('Plugins');
    expect(document.querySelector<HTMLButtonElement>('section[aria-label="Plugin settings"] button')?.disabled).toBe(true);
    expect(document.querySelector('section[aria-label="Plugin settings"]')?.textContent).toContain('not connected yet');
  });
});

test('header pack import preserves the open draft on cancellation or failure and waits for installation before selection', async () => {
  const f = fixture();
  const pack = createHomiePack({ ...f.first, name: 'Imported Homie' }, f.first.permissions);
  const installation = registryDeferred<typeof pack>();
  let mode = 'cancel';
  f.registry.importPackage = async () => {
    if (mode === 'fail') throw Error('Invalid pack');
    return mode === 'cancel' ? null : pack;
  };
  f.registry.installPackage = async () => installation.promise;
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry} />);
    await ui.click(f.first.name); await ui.type('Agent name', 'Keep draft');
    await ui.click('Import Homie pack'); expect(name()).toBe('Keep draft');
    mode = 'fail'; await ui.click('Import Homie pack');
    expect(name()).toBe('Keep draft'); expect(document.body.textContent).toContain('Invalid pack');
    mode = 'success'; await ui.click('Import Homie pack');
    expect(name()).toBe('Keep draft');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="New agent"]')?.disabled).toBe(true);
    await act(async () => installation.resolve(pack));
    expect(name()).toBe('Imported Homie'); expect(f.saves).toHaveLength(0);
    await ui.click('All Homies'); await ui.click(f.first.name); expect(name()).toBe('Keep draft');
  });
});


test('Homies list renders in the sidebar while settings stay central and retain drafts on return', async () => {
  const f = fixture();
  await withDOM(async ui => {
    const target = document.createElement('aside');
    target.setAttribute('aria-label', 'Test Homies sidebar');
    document.body.append(target);
    const edits: boolean[] = [];
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry}
      listTarget={target} onEditingChange={editing => edits.push(editing)} />);
    expect(target.querySelector('[aria-label="Agent selection"]')).not.toBeNull();
    expect(edits.at(-1)).toBe(false);
    await ui.click(f.first.name);
    expect(target.querySelector('[aria-label="Agent selection"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agent details"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="Agent details"]')).toBeNull();
    expect(edits.at(-1)).toBe(true);
    await ui.type('Agent name', 'Keep sidebar draft');
    await ui.click('All Homies');
    expect(target.querySelector('[aria-label="Agent selection"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Agent details"]')).toBeNull();
    expect(edits.at(-1)).toBe(false);
    await ui.click(f.first.name);
    expect(name()).toBe('Keep sidebar draft');
    expect(f.saves).toHaveLength(0);
    await ui.click('All Homies'); await ui.click('New agent');
    expect(target.querySelector('[aria-label="Agent details"]')).toBeNull();
    expect(name()).toBe('');
    expect(edits.at(-1)).toBe(true);
  });
});
