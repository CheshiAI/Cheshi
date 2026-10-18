import { expect, test } from 'bun:test';
import { act } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import type { AgentManagementApi } from '../shared/agent-management';
import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent } from '../shared/agent-registry';
import type { HomieSourceState } from '../shared/homie-source';
import { avatarPng } from './agent-avatar-image-fixtures';
import { defaultAgentAvatar } from '../shared/agent-avatar';
import { withRuntimePolling } from './agent-runtime-test-polling';
import type { AgentRuntimeState } from '../shared/agent-runtime';

function fixture() {
  const first = specialistAgent();
  const second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Review' };
  let snapshot: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [first, second] };
  const saves: SaveSpecialistAgent[] = [];
  const registry: AgentRegistryApi = {
    list: async () => snapshot, models: async () => [], onDidChange: () => () => {},
    save: async input => {
      saves.push(input);
      const agent = { ...first, ...input.profile, id: input.id ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', revision: 2,
        assignments: input.assignment.assigned ? [{ workspaceRoot: '/project', instructions: '', permissions: input.assignment.permissions ?? undefined }] : [] };
      snapshot = { ...snapshot, agents: [...snapshot.agents.filter(item => item.id !== agent.id), agent] };
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
const name = () => document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value ?? document.querySelector('[aria-label="Agent details"] h2')?.textContent;
const localDraft = () => document.querySelector('[aria-label="Allow agent commands"]')?.getAttribute('aria-checked');

test('Homie selection expands one inline editor and retains drafts across collapse and switching', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry} />);
    expect(document.querySelector('[aria-label="Agent selection"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Search Homies"]')).toBeNull();
    await ui.click(f.first.name); await ui.click('Allow agent commands');
    expect(Boolean(document.querySelector('[aria-label="Agent selection"]'))).toBe(true);
    await ui.click(f.second.name);
    expect(name()).toBe(f.second.name);
    await ui.click(f.first.name);
    expect(name()).toBe(f.first.name);
    expect(localDraft()).toBe('true');
    expect(f.saves).toHaveLength(0);
    await ui.click('New agent'); expect(name()).toBe('');
    expect(document.querySelector('section[aria-label="Plugin settings"]')).toBeNull();
    await ui.click('All Homies'); await ui.click(f.first.name);
    expect(localDraft()).toBe('true');
    expect(f.saves).toHaveLength(0);
  });
});

test('rapid accordion toggles retain the draft, save the selected Homie and stop polling after collapse', async () => {
  const f = fixture(), reads: string[] = [];
  f.registry.source = async request => {
    reads.push(request.agentId);
    return { directory: '/homie', phase: 'applied', message: 'Applied', hash: null };
  };
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry} />);
    expect(reads).toEqual([]);
    await ui.click(f.first.name); await ui.click('Allow agent commands');
    const toggle = () => document.querySelector<HTMLButtonElement>(`[aria-label="${f.first.name}"]`)!;
    for (let i = 0; i < 10; i++) {
      await ui.click(f.first.name);
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelectorAll('[aria-label="Agent settings"]')).toHaveLength(0);
      // Immediate unmount must preserve the draft for the next open.
      await ui.click(f.first.name);
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(localDraft()).toBe('true');
      expect(document.querySelectorAll('form[aria-label="Agent settings"]')).toHaveLength(1);
    }
    await ui.click('Save local settings');
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]?.id).toBe(f.first.id);
    expect(f.saves[0]?.assignment.permissions?.commandExecution).toBe(true);
    await ui.click(f.first.name);
    expect(document.querySelectorAll('form[aria-label="Agent settings"]')).toHaveLength(0);
    const before = reads.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
    expect(reads).toHaveLength(before);
    expect(reads.every(id => id === f.first.id)).toBe(true);
    await ui.click(f.first.name);
    expect(localDraft()).toBe('true');
  });
});

test('a late source response from a collapsed Homie cannot replace the current settings', async () => {
  const f = fixture(), pending = registryDeferred<HomieSourceState>();
  f.registry.source = async request => request.agentId === f.first.id ? pending.promise
    : { directory: '/second', phase: 'applied', message: 'Applied', hash: null };
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry} />);
    await ui.click(f.first.name); await ui.click(f.second.name);
    await act(async () => pending.resolve({ directory: '/first', phase: 'invalid', message: 'Old response', hash: null }));
    expect(name()).toBe(f.second.name);
    expect(document.querySelectorAll('form[aria-label="Agent settings"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Old response');
    expect(f.saves).toHaveLength(0);
  });
});

test('Homies offers fresh creation without import and preserves the existing settings draft', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry} />);
    await ui.click(f.first.name); await ui.click('Allow agent commands');
    expect(document.body.textContent).not.toContain('Import Homie');
    await ui.click('New agent');
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Create agent');
    expect(name()).toBe('');
    expect(document.body.textContent).not.toContain('Import Homie');
    await ui.click('All Homies'); await ui.click(f.first.name);
    expect(localDraft()).toBe('true');
    expect(f.saves).toHaveLength(0);
  });
});

test('rail selection replaces the full-height sidebar editor while retaining each draft; creation stays in the sidebar', async () => {
  const f = fixture();
  await withDOM(async ui => {
    const target = document.createElement('aside');
    target.setAttribute('aria-label', 'Test Homies sidebar');
    document.body.append(target);
    const edits: boolean[] = [];
    const render = (agentId: string) => ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry}
      listTarget={target} selectionRequest={{ agentId }} onEditingChange={editing => edits.push(editing)} />);
    await render(f.first.id);
    expect(target.querySelectorAll('[aria-label="Agent details"]').length).toBe(1);
    expect(target.querySelectorAll('[aria-label="Agent selection"]').length).toBe(0);
    expect(target.querySelectorAll(`[aria-label="${f.second.name}"]`).length).toBe(0);
    expect(edits.at(-1)).toBe(false);
    await ui.click('Allow agent commands');
    await render(f.second.id);
    expect(name()).toBe(f.second.name);
    await render(f.first.id);
    expect(localDraft()).toBe('true');
    expect(target.querySelectorAll(`button[aria-label="${f.first.name}"]`).length).toBe(0);
    expect(target.querySelector('header h2')?.textContent).toBe(f.first.name);
    expect(target.querySelectorAll('[aria-label="Agent details"]').length).toBe(1);
    expect(localDraft()).toBe('true');
    expect(f.saves).toHaveLength(0);
    await render('new');
    expect(target.querySelectorAll('[aria-label="Agent details"]').length).toBe(1);
    expect(target.querySelectorAll('form[aria-label="Create agent"]').length).toBe(1);
    expect(edits.at(-1)).toBe(false);
  });
});

test('sidebar heading follows the selected Homie display name and avatar and labels its settings', async () => {
  const f = fixture();
  const first = { ...f.first, displayName: 'my Development', avatar: { ...defaultAgentAvatar(f.first.id), image: avatarPng } };
  f.registry.list = async () => ({ workspaceRoot: '/project', agents: [first, f.second] });
  const workers = [first, f.second].map(agent => ({ id: `worker-${agent.id}`, name: `container-${agent.name}`, image: 'test', state: 'running', profileId: agent.id }));
  workers[1]!.state = 'exited';
  f.api.engines = async () => ({ engines: [{ id: 'docker:test', name: 'Test', supported: true, reason: null }], error: null });
  f.api.snapshot = async engineId => ({ engineId, online: true, error: null, agents: workers });
  f.api.details = async (_engineId, id) => ({ agent: workers.find(worker => worker.id === id)!, ready: true, authenticated: true,
    busy: false, threadId: null, logs: '', tasks: [], error: null });
  await withDOM(async ui => {
    const target = document.createElement('aside');
    document.body.append(target);
    const render = (agentId: string) => ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry}
      listTarget={target} selectionRequest={{ agentId }} onClose={() => {}} />);
    await render(first.id);
    const heading = () => target.querySelector('header h2');
    expect(heading()?.textContent).toBe(first.displayName);
    expect(heading()?.querySelector('img')?.getAttribute('src')).toBe(avatarPng);
    expect(target.querySelectorAll(`button[aria-label="${first.displayName}"]`).length).toBe(0);
    expect(target.querySelector('[role="region"]')?.getAttribute('aria-labelledby')).toBe(heading()?.id);
    expect([...target.querySelectorAll('header button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['Start agent', `More actions: ${first.displayName}`, 'Close Homies']);
    expect(heading()?.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(first.displayName);
    expect(target.querySelectorAll('[aria-label="Selected Homie"] [role="group"][aria-label^="Homie controls:"]').length).toBe(0);
    await ui.click(`More actions: ${first.displayName}`);
    expect(document.querySelector('[role="menu"]')?.firstElementChild?.textContent).toBe(first.displayName);
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(`container-${first.name}`);
    expect(document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Container · Running"]')?.disabled).toBe(true);
    expect(target.querySelectorAll('form[aria-label="Agent settings"]').length).toBe(1);
    await ui.click(`Delete agent: ${first.displayName}`);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('dialog')?.textContent).toContain(first.displayName);
    await ui.click('Cancel');
    expect(document.querySelectorAll('dialog').length).toBe(0);
    for (const label of ['Close Homies', `More actions: ${first.displayName}`]) {
      expect(target.querySelectorAll(`[aria-label="${label}"]`).length).toBe(1);
    }
    await ui.click(`More actions: ${first.displayName}`);
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`More actions: ${first.displayName}`);
    await ui.click(`More actions: ${first.displayName}`);
    await render(f.second.id);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(heading()?.textContent).toBe(f.second.name);
    expect(heading()?.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(f.second.name);
    await ui.click(`More actions: ${f.second.name}`);
    expect(document.querySelector('[role="menu"]')?.firstElementChild?.textContent).toBe(f.second.name);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Container · Stopped');
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain(`container-${first.name}`);
    expect(heading()?.querySelectorAll('img').length).toBe(0);
    expect(target.querySelector('[role="region"]')?.getAttribute('aria-labelledby')).toBe(heading()?.id);
    await render('new');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('main[aria-label="Homies"] > header')?.textContent).toContain('HOMIES');
    expect([...document.querySelectorAll('main[aria-label="Homies"] > header button')].some(button => button.textContent === 'Import Homie pack')).toBe(false);
  });
});

test('sidebar avatar status follows runtime observations and its menu is locked while saving', async () => {
  const f = fixture();
  f.first.assignments = [{ workspaceRoot: '/project', instructions: '' }];
  let runtime: AgentRuntimeState = { details: null, lifecycle: { phase: 'sleeping', error: null } };
  f.registry.runtime = async () => runtime;
  f.api.engines = async () => ({ engines: [{ id: 'docker:test', name: 'Test', supported: true, reason: null }], error: null });
  const saved = registryDeferred<Awaited<ReturnType<AgentRegistryApi['save']>>>();
  const save = f.registry.save;
  f.registry.save = async input => { await saved.promise; return save(input); };
  await withRuntimePolling(async poll => {
    await withDOM(async ui => {
      const target = document.createElement('aside'); document.body.append(target);
      await ui.render(<AgentManagementViews view="homies" api={f.api} registryApi={f.registry}
        listTarget={target} selectionRequest={{ agentId: f.first.id }} onClose={() => {}} />);
      const badge = () => target.querySelector('header h2 [role="img"]');
      expect(badge()?.getAttribute('aria-label')).toBe(`${f.first.name}: Sleeping`);
      expect(badge()?.parentElement?.getAttribute('aria-description')).toBe('Sleeping');
      runtime = { details: { agent: { id: 'worker', name: 'Worker', state: 'running', image: 'test' },
        ready: true, busy: true, authenticated: true, threadId: null, logs: '', tasks: [], error: null } };
      await poll();
      expect(badge()?.getAttribute('aria-label')).toBe(`${f.first.name}: Working`);
      expect(badge()?.parentElement?.getAttribute('aria-description')).toBe('Working');
      await ui.click(`More actions: ${f.first.name}`);
      expect(document.querySelector('[role="menu"]')?.textContent).toContain('Container · Not connected');
      await ui.click(`More actions: ${f.first.name}`);
      await ui.click('Save local settings');
      expect(target.querySelector<HTMLButtonElement>(`button[aria-label="More actions: ${f.first.name}"]`)?.disabled).toBe(true);
      await ui.click(`More actions: ${f.first.name}`);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await act(async () => saved.resolve({ agentId: f.first.id, snapshot: { workspaceRoot: '/project', agents: [f.first, f.second] } }));
      expect(target.querySelector<HTMLButtonElement>(`button[aria-label="More actions: ${f.first.name}"]`)?.disabled).toBe(false);
    });
  });
});
