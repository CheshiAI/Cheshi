import { expect, test } from 'bun:test';
import { act } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import type { AgentDetails, AgentManagementApi } from '../shared/agent-management';
import type { AgentRegistryApi, AgentRegistrySnapshot } from '../shared/agent-registry';

test('requested Homies open settings after loading, retain drafts in Advanced, and close without worker mutations', async () => {
  const first = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const second = { ...first, id: 'second', name: 'Second Homie' };
  const pending = registryDeferred<AgentRegistrySnapshot>();
  const actions: string[] = [];
  const registry: AgentRegistryApi = {
    list: () => pending.promise, models: async () => [], onDidChange: () => () => {},
    save: async () => { throw Error('Navigation must not save'); },
    runtime: async request => { actions.push(request.action); return { details: null }; },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ engines: [{ id: 'docker:test', name: 'Test', supported: true, reason: null }], error: null }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: [] }),
    details: async () => { throw Error('No worker'); }, control: async () => { throw Error('Navigation must not control workers'); },
  };
  await withDOM(async ui => {
    let selectionRequest: { agentId: string | null } = { agentId: second.id };
    let closed = 0;
    const render = (active = true) => ui.render(<AgentManagementViews view="homies" active={active}
      selectionRequest={selectionRequest} api={api} registryApi={registry} onClose={() => { closed++; }} />);
    await render();
    await act(async () => pending.resolve({ workspaceRoot: '/project', agents: [first, second] }));
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe(second.name);
    expect(actions).toEqual([]);
    await ui.type('Agent name', 'Unsaved name');
    const form = document.querySelector('form');
    await ui.click('Advanced');
    expect(actions).toEqual(['status']);
    expect(document.querySelector('[aria-label="Agent task"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Run task');
    await ui.click('Agent settings');
    expect(document.querySelector('form')).toBe(form);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe('Unsaved name');
    await ui.click('Close Homies');
    await render(false);
    expect(closed).toBe(1);
    expect(actions).toEqual(['status']);
    selectionRequest = { agentId: first.id }; await render();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe(first.name);
    selectionRequest = { agentId: null }; await render();
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).toContain(second.name);
    await ui.click('New agent');
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Create agent');
    expect(actions).toEqual(['status']);
  });
});

test('Advanced exposes logs, omits completed history, and stops only its idle worker', async () => {
  const agent = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const worker = { id: 'worker', name: 'Worker', image: 'fixture', state: 'running', profileId: agent.id };
  let details: AgentDetails = { agent: worker, ready: true, authenticated: true, busy: true, threadId: 'thread', error: null,
    logs: 'Worker diagnostic output', tasks: [
      { id: 'done', prompt: 'Completed history', status: 'completed', createdAt: '2026-10-06', output: 'Done', error: null },
      { id: 'running', prompt: 'Active work', status: 'running', createdAt: '2026-10-06', output: '', error: null },
    ] };
  const controls: string[] = [];
  const registry: AgentRegistryApi = {
    list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [], onDidChange: () => () => {},
    save: async () => { throw Error('unused'); },
    runtime: async request => { expect(request.action).toBe('status'); return { details: structuredClone(details) }; },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ engines: [{ id: 'docker:test', name: 'Test', supported: true, reason: null }], error: null }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: [details.agent] }),
    details: async () => details,
    control: async (engine, id, action) => {
      controls.push(`${engine}/${id}/${action}`);
      details = { ...details, agent: { ...worker, state: 'exited' }, ready: false };
      return { engineId: engine, online: true, error: null, agents: [details.agent] };
    },
  };
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" api={api} registryApi={registry} selectionRequest={{ agentId: agent.id }} />);
    await ui.click('Advanced');
    expect(document.body.textContent).not.toContain('Completed history');
    expect(document.body.textContent).toContain('Active work');
    expect(document.querySelector('[aria-label="Worker log output"]')?.textContent).toBe('Worker diagnostic output');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Stop worker"]')?.disabled).toBe(true);
    await ui.click('Stop worker'); expect(controls).toEqual([]);
    details = { ...details, busy: false, tasks: [details.tasks[0]!] };
    await ui.click('Refresh agent'); await ui.click('Stop worker');
    expect(controls).toEqual(['docker:test/worker/stop']);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Stop worker"]')?.disabled).toBe(true);
  });
});
