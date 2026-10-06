import { expect, spyOn, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { SpecialistRuntimePanel } from '../frontend/src/features/agents/SpecialistRuntimePanel';
import type { AgentRegistryApi, AgentRegistrySnapshot } from '../shared/agent-registry';
import type { AgentDetails, AgentManagementApi } from '../shared/agent-management';
import type { AgentRuntimeState } from '../shared/agent-runtime';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';

async function withDOM(run: (render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const element = document.createElement('div'); document.body.append(element);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(element);
  try { await run(async node => { await act(async () => root.render(node)); }); }
  finally {
    await act(async () => root.unmount()); await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const engines = [{ id: 'docker:local', name: 'local', supported: true, reason: null }];
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const details: AgentDetails = { agent: { id: 'worker', name: 'Worker', state: 'running', image: 'fixture' },
  ready: true, busy: false, authenticated: true, threadId: 'thread', error: null, logs: '', tasks: [
    { id: 'task', status: 'unknown', prompt: 'Old task', output: 'Old result', error: null, createdAt: '2026-10-04' },
  ] };

test('deletion fallback to an unassigned agent shows guidance without querying or starting it', async () => {
  const assigned = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const other = { ...specialistAgent(), id: 'b1234567-1234-1234-1234-123456789abc', name: 'Other agent' };
  let snapshot: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [assigned, other] };
  let publish: (value: AgentRegistrySnapshot) => void = () => {};
  const calls: string[] = [];
  const registry: AgentRegistryApi = {
    list: async () => snapshot, models: async () => [], save: async () => { throw Error('unused'); },
    onDidChange: listener => { publish = listener; return () => {}; },
    runtime: async request => { calls.push(request.agentId); return { details }; },
  };
  const management: AgentManagementApi = {
    engines: async () => ({ engines, error: null }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: [] }),
    details: async () => details, control: async () => { throw Error('Must not execute'); },
  };
  await withDOM(async render => {
    await render(<AgentManagementViews view="homies" api={management} registryApi={registry} />);
    await act(async () => button(assigned.name).click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Files and environment')!.click());
    expect(calls).toEqual([assigned.id]);
    snapshot = { ...snapshot, agents: [other] };
    await act(async () => publish(snapshot));
    expect(document.querySelector('form')).toBeNull();
    expect(document.body.textContent).not.toContain('Old task');
    await act(async () => button(other.name).click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Files and environment')!.click());
    expect(document.body.textContent).toContain('Assign this agent to the current project in Agent settings.');
    expect(button('Start agent').disabled).toBe(true);
    await act(async () => { button('Start agent').click(); button('Refresh agent').click(); });
    expect(calls).toEqual([assigned.id]);
    snapshot = { ...snapshot, agents: [{ ...other, revision: 2, assignments: assigned.assignments }] };
    await act(async () => publish(snapshot));
    expect(calls).toEqual([assigned.id, other.id]);
    expect(button('Start agent').disabled).toBe(false);
    snapshot = { ...snapshot, workspaceRoot: '/other-project' };
    await act(async () => publish(snapshot));
    expect(button('Start agent').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('Old task');
    expect(calls).toHaveLength(2);
  });
});

test.each(['agent-unassigned', 'agent-removed'] as const)('in-flight %s clears old details and stops polling until registry refresh', async kind => {
  const agent = specialistAgent();
  let calls = 0, current: AgentRuntimeState = { details };
  const registry = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], save: async () => { throw Error('unused'); }, onDidChange: () => () => {},
    runtime: async () => { calls++; return current; } });
  const timers = spyOn(globalThis, 'setInterval');
  try {
    await withDOM(async render => {
      const panel = (revision: number) => <SpecialistRuntimePanel agent={{ ...agent, revision }} assigned
        model={registry} engines={engines} engineId="docker:local" onSettings={() => {}} />;
      await render(panel(1));
      expect(document.body.textContent).toContain('Old task');
      current = { details: null, unavailable: { kind, message: 'Binding unavailable' } };
      await act(async () => button('Refresh agent').click());
      expect(document.body.textContent).not.toContain('Old task');
      expect(document.querySelector('[role="status"]')?.textContent).toBe('Binding unavailable');
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(button('Start agent').disabled).toBe(true);
      const poll = timers.mock.calls.find(call => call[1] === 10_000)?.[0];
      if (typeof poll !== 'function') throw Error('Polling callback not found');
      await act(async () => { poll(); poll(); });
      expect(calls).toBe(2);
      current = { details };
      await render(panel(2));
      expect(calls).toBe(3);
      expect(document.body.textContent).toContain('Old task');
      expect(button('Start agent').disabled).toBe(false);
    });
  } finally { timers.mockRestore(); registry.dispose(); }
});

test('a late status result cannot restore details after unassignment', async () => {
  const agent = specialistAgent(), pending = registryDeferred<AgentRuntimeState>();
  let calls = 0;
  const registry = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], save: async () => { throw Error('unused'); }, onDidChange: () => () => {},
    runtime: async () => { calls++; return calls === 1 ? pending.promise : { details }; } });
  try {
    await withDOM(async render => {
      const panel = (assigned: boolean) => <SpecialistRuntimePanel agent={agent} assigned={assigned}
        model={registry} engines={engines} engineId="docker:local" onSettings={() => {}} />;
      await render(panel(true)); await render(panel(false));
      await act(async () => pending.resolve({ details }));
      expect(document.body.textContent).not.toContain('Old task');
      expect(button('Start agent').disabled).toBe(true);
      expect(calls).toBe(1);
      await render(panel(true));
      expect(calls).toBe(2); expect(document.body.textContent).toContain('Old task');
    });
  } finally { registry.dispose(); }
});
