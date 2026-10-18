import { expect, test } from 'bun:test';
import { act } from 'react';
import { SpecialistRuntimePanel } from '../frontend/src/features/agents/SpecialistRuntimePanel';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { AgentDetails } from '../shared/agent-management';
import type { AgentRuntimeState } from '../shared/agent-runtime';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';
import { withRuntimePolling } from './agent-runtime-test-polling';

const engines = [{ id: 'docker:test', name: 'Test', supported: true, reason: null }];
const running: AgentDetails = { agent: { id: 'worker', name: 'Worker', state: 'running', image: 'fixture' },
  ready: true, busy: false, authenticated: true, threadId: null, error: null, logs: '', tasks: [] };
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

test('header power control waits for status, toggles start/stop, and blocks duplicate and locked actions', async () => {
  const agent = specialistAgent(), initial = registryDeferred<AgentRuntimeState>();
  const start = registryDeferred<AgentRuntimeState>(), stop = registryDeferred<void>();
  const calls: string[] = [], stops: string[] = [];
  let current: AgentRuntimeState = { details: null };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], save: async () => { throw Error('unused'); }, onDidChange: () => () => {},
    runtime: async request => {
      calls.push(request.action);
      if (calls.length === 1) return initial.promise;
      return request.action === 'start' ? start.promise : current;
    } });
  const onStopWorker = async (engine: string, worker: string) => {
    stops.push(`${engine}/${worker}`);
    await stop.promise;
    current = { details: { ...running, agent: { ...running.agent, state: 'exited' }, ready: false } };
  };
  try {
    await withDOM(async ui => {
      const target = document.createElement('header'); document.body.append(target);
      const render = (disabled = false) => ui.render(<SpecialistRuntimePanel agent={agent} assigned model={model}
        engines={engines} engineId="docker:test" actionsTarget={target} disabled={disabled} onStopWorker={onStopWorker} />);
      await render();
      expect(target.querySelectorAll('button').length).toBe(1);
      expect(button('Start agent')?.disabled).toBe(true);
      await ui.click('Start agent'); expect(calls).toEqual(['status']);
      expect(document.querySelector('section[aria-label="Status"]')).not.toBeNull();
      expect(document.querySelector('section[aria-label="Power controls"]')).toBeNull();
      expect(button('Refresh agent')).toBeNull(); expect(button('Agent settings')).toBeNull();
      await act(async () => initial.resolve(current));
      expect(button('Start agent')?.disabled).toBe(false);
      await render(true); await ui.click('Start agent'); expect(calls).toEqual(['status']);
      await render(); await ui.click('Start agent'); await ui.click('Start agent');
      expect(calls).toEqual(['status', 'start']); expect(button('Start agent')?.disabled).toBe(true);
      current = { details: running };
      await act(async () => start.resolve(current));
      expect(button('Start agent')).toBeNull(); expect(button('Stop worker')?.disabled).toBe(false);
      await ui.click('Stop worker'); await ui.click('Stop worker');
      expect(stops).toEqual(['docker:test/worker']); expect(button('Stop worker')?.disabled).toBe(true);
      await act(async () => stop.resolve());
      expect(button('Stop worker')).toBeNull(); expect(button('Start agent')?.disabled).toBe(false);
      expect(calls).toEqual(['status', 'start', 'status']);
    });
  } finally { model.dispose(); }
});

test('automatic observations block unsafe stops, recover from failed reads, and preserve start retries', async () => {
  const agent = specialistAgent();
  let current: AgentRuntimeState = { details: running }, readFailure = false;
  const starts: string[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], save: async () => { throw Error('unused'); }, onDidChange: () => () => {},
    runtime: async request => {
      if (request.action === 'start') { starts.push(request.action); throw Error('Start failed; retry.'); }
      if (readFailure) throw Error('Status unavailable');
      return current;
    } });
  try {
    await withRuntimePolling(async poll => {
      await withDOM(async ui => {
        await ui.render(<SpecialistRuntimePanel agent={agent} assigned model={model} engines={engines} engineId="docker:test"
          onStopWorker={async () => { throw Error('Unsafe stop must not run'); }} />);
        expect(button('Stop worker')?.disabled).toBe(false);
        for (const state of ['busy', 'accepted', 'running', 'waiting', 'unknown', 'starting', 'draining', 'error']) {
          current = { details: { ...running, busy: state === 'busy', error: state === 'error' ? 'Worker error' : null,
            tasks: ['accepted', 'running', 'waiting', 'unknown'].includes(state)
              ? [{ id: 'task', status: state, prompt: '', output: '', error: null, createdAt: '' }] : [] },
            ...(['starting', 'draining'].includes(state) ? { lifecycle: { phase: state as 'starting' | 'draining', error: null } } : {}) };
          await poll(); expect(button('Stop worker')?.disabled).toBe(true);
          expect(button('Start agent')).toBeNull(); await ui.click('Stop worker');
        }
        current = { details: null, lifecycle: { phase: 'sleeping', error: null } };
        await poll(); expect(button('Start agent')?.disabled).toBe(false);
        readFailure = true; await poll(); expect(button('Start agent')?.disabled).toBe(true);
        readFailure = false; await poll(); expect(button('Start agent')?.disabled).toBe(false);
        await ui.click('Start agent'); expect(button('Start agent')?.disabled).toBe(false);
        await poll();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Start failed; retry.');
        await ui.click('Start agent'); expect(starts).toEqual(['start', 'start']);
        current = { details: running };
        await poll();
        expect(document.querySelector('[role="alert"]')).toBeNull();
      });
    });
  } finally { model.dispose(); }
});
