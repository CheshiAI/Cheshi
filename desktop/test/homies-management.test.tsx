import { withRuntimePolling } from './agent-runtime-test-polling';
import { expect, test } from 'bun:test';
import { act } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import type { AgentDetails, AgentManagementApi, ManagedAgent } from '../shared/agent-management';
import type { AgentRuntimeState } from '../shared/agent-runtime';
import type { AgentRegistryApi, AgentRegistrySnapshot } from '../shared/agent-registry';

test('requested Homies open settings after loading, retain drafts in Runtime, and close without worker mutations', async () => {
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
    expect(document.querySelector('h2')?.textContent).toBe(second.name);
    expect(actions).toEqual(['status']);
    expect(document.querySelector('[aria-label="Homie runtime controls"] [aria-label="Start agent"]')).not.toBeNull();
    await ui.click('Allow agent commands');
    const form = document.querySelector('form');
    expect(actions).toEqual(['status']);
    expect(document.querySelector('[aria-label="Agent task"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Run task');

    expect(document.querySelector('form')).toBe(form);
    expect(document.querySelector('[aria-label="Allow agent commands"]')?.getAttribute('aria-checked')).toBe('true');
    await ui.click('Close Homies');
    await render(false);
    expect(closed).toBe(1);
    expect(actions).toEqual(['status']);
    selectionRequest = { agentId: first.id }; await render();
    expect(document.querySelector('h2')?.textContent).toBe(first.name);
    selectionRequest = { agentId: null }; await render();
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).toContain(second.name);
    await ui.click('New agent');
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Create agent');
    expect(actions.every(action => action === 'status')).toBe(true);
  });
});

test('Homie settings show compact status without logs or task history and stop only an idle worker', async () => {
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
  await withRuntimePolling(async poll => {
    await withDOM(async ui => {
      await ui.render(<AgentManagementViews view="homies" api={api} registryApi={registry} selectionRequest={{ agentId: agent.id }} />);
      expect(document.body.textContent).not.toContain('Completed history');
      expect(document.body.textContent).not.toContain('Active work');
      expect(document.querySelectorAll('[aria-label^="Homie status:"][aria-description="Working"]')).toHaveLength(1);
      expect(document.querySelector('[aria-label="Worker log output"]')).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="Stop worker"]')?.disabled).toBe(true);
      await ui.click('Stop worker'); expect(controls).toEqual([]);
      details = { ...details, busy: false, tasks: [details.tasks[0]!] };
      await poll();
      expect(document.querySelectorAll('[aria-label^="Homie status:"][aria-description="Ready"]')).toHaveLength(1);
      await ui.click('Stop worker');
      expect(controls).toEqual(['docker:test/worker/stop']);
      expect(document.querySelector('[aria-label="Stop worker"]')).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="Start agent"]')?.disabled).toBe(false);
    });
  });
});


test('Homie icons reuse observed list status and only query runtime while expanded', async () => {
  const agent = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  let worker: ManagedAgent = { id: 'worker', name: 'Worker', image: 'fixture', state: 'exited', profileId: agent.id,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    status: { observedAt: Date.now(), lifecycle: { phase: 'sleeping', stopReason: 'sleep', error: null } } };
  let online = true;
  let runtime: AgentRuntimeState = { details: null, lifecycle: { phase: 'sleeping', error: null } };
  let pendingRuntime: ReturnType<typeof registryDeferred<AgentRuntimeState>> | undefined;
  const calls: string[] = [];
  const registry: AgentRegistryApi = {
    list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [], onDidChange: () => () => {},
    save: async () => { throw Error('Navigation must not save'); },
    runtime: async request => { calls.push(request.action); return pendingRuntime ? pendingRuntime.promise : runtime; },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ engines: [{ id: 'docker:test', name: 'Test', supported: true, reason: null }], error: null }),
    snapshot: async engineId => ({ engineId, online, error: null, agents: [worker] }),
    details: async () => ({ agent: worker, ready: false, busy: false, authenticated: null, threadId: null, error: null, logs: '', tasks: [] }),
    control: async () => { throw Error('Navigation must not execute'); },
  };
  await withRuntimePolling(async poll => {
    await withDOM(async ui => {
      await ui.render(<AgentManagementViews view="homies" api={api} registryApi={registry} />);
      const icon = () => document.querySelector<HTMLButtonElement>(`[aria-label="Homie status: ${agent.name}"]`);
      expect(icon()?.getAttribute('aria-description')).toBe('Sleeping');
      worker = { ...worker, status: { observedAt: Date.now() - 31_000, lifecycle: { phase: 'sleeping', stopReason: 'sleep', error: null } } };
      await ui.click('Refresh');
      expect(icon()?.getAttribute('aria-description')).toBe('Status unknown');
      worker = { ...worker, status: { observedAt: Date.now(), lifecycle: { phase: 'disabled', stopReason: 'manual', error: null } } };
      await ui.click('Refresh');
      expect(icon()?.getAttribute('aria-description')).toBe('Manually stopped');
      online = false; await ui.click('Refresh');
      expect(icon()?.getAttribute('aria-description')).toBe('Engine disconnected');
      expect(calls).toEqual([]);
      online = true;
      worker = { ...worker, status: { observedAt: Date.now(), lifecycle: { phase: 'sleeping', stopReason: 'sleep', error: null } } };
      await ui.click('Refresh');
      const group = document.querySelector(`[aria-label="Homie controls: ${agent.name}"]`)!;
      expect(Array.from(group.querySelectorAll('button, [role="img"]'), node => node.getAttribute('aria-label')))
        .toEqual([`Homie status: ${agent.name}`, 'Container connection: Worker', `Delete agent: ${agent.name}`]);
      const originalButton = icon();
      pendingRuntime = registryDeferred<AgentRuntimeState>();
      await ui.click(agent.name);
      expect(calls).toEqual(['status']);
      expect(icon()?.getAttribute('aria-description')).toBe('Sleeping');
      expect(icon() === originalButton).toBe(true);
      expect(icon()?.getAttribute('aria-expanded')).toBe('true');
      await act(async () => pendingRuntime!.resolve(runtime));
      pendingRuntime = undefined;
      expect(icon()?.getAttribute('aria-description')).toBe('Sleeping');
      const actions = document.querySelector('[aria-label="Homie actions"]')!;
      const container = document.querySelector('section[aria-label="Container"]')!;
      const status = document.querySelector('section[aria-label="Status"]')!;
      expect(Boolean(container.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(Boolean(container.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(container.querySelectorAll('[aria-label="Agent execution engine"]')).toHaveLength(1);
      expect(status.querySelectorAll('button')).toHaveLength(0);
      expect(document.querySelectorAll('[aria-label="Homie runtime controls"] button[aria-label="Start agent"]')).toHaveLength(1);
      runtime = { details: null, lifecycle: { phase: 'error', error: 'Invalid configuration' } };
      await poll();
      expect(icon()?.getAttribute('aria-description')).toBe('Error');
      expect(document.querySelector('[aria-label="Docker runtime"] [role="alert"]')?.textContent).toBe('Invalid configuration');
      await act(async () => { (icon() as HTMLElement).click(); });
      expect(document.querySelectorAll('form[aria-label="Agent settings"]')).toHaveLength(0);
      expect(document.querySelector(`[aria-label="${agent.name}"]`)?.getAttribute('aria-expanded')).toBe('false');
      expect(calls).toEqual(['status', 'status']);
      for (let index = 0; index < 3; index++) {
        pendingRuntime = registryDeferred<AgentRuntimeState>();
        await ui.click(`Homie status: ${agent.name}`);
        expect(icon()?.getAttribute('aria-description')).toBe('Sleeping');
        expect(icon() === originalButton).toBe(true);
        await act(async () => pendingRuntime!.resolve({ details: null, lifecycle: { phase: 'sleeping', error: null } }));
        expect(icon()?.getAttribute('aria-description')).toBe('Sleeping');
        await ui.click(`Homie status: ${agent.name}`);
        expect(icon()?.getAttribute('aria-expanded')).toBe('false');
      }
      pendingRuntime = registryDeferred<AgentRuntimeState>();
      await ui.click(`Homie status: ${agent.name}`);
      expect(icon()?.getAttribute('aria-description')).toBe('Sleeping');
      await act(async () => pendingRuntime!.resolve({ details: null }));
      expect(icon()?.getAttribute('aria-description')).toBe('Not running');
      expect(calls).toEqual(Array(6).fill('status'));
    });
  });
});
