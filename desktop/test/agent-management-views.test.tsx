import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { AgentTaskResults } from '../frontend/src/features/agents/AgentTaskResults';
import { ExecutionHealth } from '../frontend/src/features/agents/ExecutionHealth';
import type { AgentManagementApi, AgentTask } from '../shared/agent-management';
import { unwrapAgentDeletion } from '../shared/agent-management';
import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent } from '../shared/agent-registry';
import { registryDeferred, specialistAgent, specialistModels } from './agent-registry-fixtures';
import type { CodexAccountsApi } from '../shared/codex-accounts';
import { useSpecialistModels } from '../frontend/src/features/agents/SpecialistModelSettings';

async function withDOM(run: (ui: { render(node: ReactNode): Promise<void>; click(label: string): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
    HTMLElement: window.HTMLElement,
    ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  try {
    await run({ render: async node => { await act(async () => root.render(node)); },
      click: async label => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item =>
          item.getAttribute('aria-label') === label || item.textContent === label);
        if (!button) throw new Error(`Missing button: ${label}`);
        await act(async () => { button.click(); });
      } });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('execution health distinguishes engine responses, task activity and unavailable snapshots', async () => {
  const health = { taskId: 'task', startedAt: '2026-10-04T00:00:00Z', lastActivityAt: '2026-10-04T00:01:00Z',
    lastActivity: 'tool' as const, checkedAt: '2026-10-04T00:02:00Z', lastResponsiveAt: '2026-10-04T00:02:00Z', engineStatus: 'responding' as const };
  await withDOM(async ({ render }) => {
    await render(<ExecutionHealth health={health} unavailable={false} />);
    expect(document.body.textContent).toContain('Execution engine responding');
    expect(document.body.textContent).toContain('Tool activity');
    expect(document.body.textContent).toContain('No execution time limit');
    await render(<ExecutionHealth health={health} unavailable />);
    expect(document.body.textContent).toContain('Status unavailable');
    expect(document.body.textContent).not.toContain('Execution engine responding');
    await render(<ExecutionHealth health={{ ...health, engineStatus: 'unconfirmed' }} unavailable={false} />);
    expect(document.body.textContent).toContain('Execution engine response unconfirmed');
  });
});

test('Docker and Agents separate controls and preserve engine/worker selection across navigation', async () => {
  let discoveries = 0;
  const inspections: string[] = [];
  const opened: string[] = [], closed: string[] = [];
  const workers = ['first', 'second'].map(id => ({ id, name: `Worker ${id}`, state: 'running', image: 'fixture:test' }));
  const api: AgentManagementApi = {
    terminal: {
      open: async (engineId, agentId) => { opened.push(agentId); return { id: `shell-${opened.length}`, engineId, agentId, ended: false, error: null }; },
      update: async () => {}, close: async id => { closed.push(id); }, onChanged: () => () => {},
    },
    engines: async () => { discoveries++; return { error: null, engines: ['one', 'two'].map(id => ({
      id: `test:${id}`, name: `Engine ${id}`, supported: true, reason: null,
    })) }; },
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: workers }),
    details: async (engineId, id) => {
      inspections.push(`${engineId}/${id}`);
      return { agent: workers.find(item => item.id === id)!, ready: true, busy: false, authenticated: id === 'second',
        threadId: `${engineId}/${id}`, error: null, logs: `log:${id}`,
        tasks: [{ id: `task-${id}`, prompt: 'Review', status: 'completed', createdAt: '2026-10-02', output: `result:${id}`, error: null }] };
    },
    control: async () => { throw new Error('Navigation must not mutate containers'); },
  };
  await withDOM(async ({ render, click }) => {
    const selectWithBlur = async (label: string, option: string) => {
      await click(label);
      const menu = document.querySelector(`[role="menu"][aria-label="${label}"]`);
      expect(menu?.getAttribute('data-regional-blur-surface')).toBe('true');
      expect(document.querySelector('main')?.contains(menu)).toBe(false);
      const item = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
        .find(button => button.textContent === option);
      if (!item) throw new Error(`Missing option: ${option}`);
      await act(async () => { item.click(); });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(menu?.hasAttribute('data-regional-blur-surface')).toBe(false);
    };
    const screen = (view: 'docker' | 'homies' | null) => <AgentManagementViews api={api} view={view} />;
    await render(screen(null));
    expect(discoveries).toBe(0);
    await render(screen('docker'));
    expect(document.querySelector('main')?.getAttribute('aria-label')).toBe('Docker');
    expect(document.querySelector('[aria-label="Container logs"]')?.textContent).toContain('log:first');
    expect(document.querySelector('[aria-label="Task results"]')).toBeNull();
    await selectWithBlur('Execution engine', 'Engine two');
    expect(document.querySelector('button[aria-label="Container"]')).toBeNull();
    await click('Worker second');
    expect(inspections.at(-1)).toBe('test:two/second');
    expect(document.querySelector('[aria-label="Container selection"] [aria-current="page"]')?.getAttribute('aria-label')).toBe('Worker second');
    expect(document.querySelector('[aria-label="Container log output"]')?.textContent).toBe('log:second');
    expect(document.querySelector('button[aria-label="Logs"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('button[aria-label="Stop"]')?.textContent).toBe('');
    expect(document.querySelector('[aria-label="Container selection"]')?.textContent).not.toContain('running');
    const logs = document.querySelector('[aria-label="Container log output"]');
    await click('Terminal');
    expect(opened).toEqual(['second']);
    await click('Logs');
    expect(document.querySelector('[aria-label="Container log output"]')).toBe(logs);
    expect(closed.length).toBe(0);
    await click('Worker first');
    expect(closed).toEqual(['shell-1']);
    await click('Worker second');
    expect(opened).toEqual(['second']);
    await render(screen('homies'));
    expect(document.querySelector('main')?.getAttribute('aria-label')).toBe('Homies');
    expect(document.querySelector('[aria-label="Execution engine"]')).toBeNull();
    expect(document.querySelector('[aria-label="Container logs"]')).toBeNull();
    expect([...document.querySelectorAll('button')].some(button => ['Start', 'Stop', 'Restart'].includes(button.textContent ?? ''))).toBe(false);
    expect(document.querySelector('[aria-label="Task result content"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agent status"]')).toBeNull();
    expect(document.querySelector('[aria-label="Task results"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agent selection"] button')).toBeNull();
    await render(screen(null));
    await render(screen('docker'));
    expect(document.querySelector('[aria-label="Execution engine"]')?.textContent).toBe('Engine two');
    expect(document.querySelector('[aria-label="Container selection"] [aria-current="page"]')?.getAttribute('aria-label')).toBe('Worker second');
    expect(inspections.at(-1)).toBe('test:two/second');
    expect(discoveries).toBe(1);
    await click('Refresh');
    expect(document.querySelector('[aria-label="Container selection"] [aria-current="page"]')?.getAttribute('aria-label')).toBe('Worker second');
  });
});

test('worker labels follow registered names and renames while retaining container tooltips and fallbacks', async () => {
  const profile = { ...specialistAgent(), name: 'Cheshi Development Specialist' };
  let stored: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [profile] };
  let publish: (snapshot: AgentRegistrySnapshot) => void = () => {};
  const registryApi: AgentRegistryApi = {
    list: async () => stored, models: async () => [], save: async () => { throw new Error('unused'); },
    onDidChange: listener => { publish = listener; return () => {}; },
  };
  const workers = [
    { id: 'worker', name: 'cheshi-agent-internal-project', profileId: profile.id, state: 'running', image: 'fixture' },
    { id: 'legacy', name: `cheshi-agent-${profile.id}-legacy`, state: 'running', image: 'fixture' },
  ];
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [{ id: 'test:local', name: 'local', supported: true, reason: null }] }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: workers }),
    details: async (_engineId, id) => ({ agent: workers.find(item => item.id === id)!, ready: true, busy: false,
      authenticated: true, threadId: null, error: null, logs: '', tasks: [] }),
    control: async () => { throw new Error('Display changes must not mutate containers'); },
  };
  await withDOM(async ({ render, click }) => {
    const screen = (view: 'docker' | 'homies') => <AgentManagementViews api={api} registryApi={registryApi} view={view} />;
    const containerRow = () => document.querySelector('[aria-label="Container selection"] [aria-current="page"]');
    const containerHeader = () => document.querySelector('[aria-label="Container status"] h2');
    await render(screen('docker'));
    expect(containerRow()?.textContent).toBe(profile.name);
    expect(containerRow()?.getAttribute('aria-description')).toBe(`${workers[0]!.name} · running`);
    expect(containerHeader()?.textContent).toBe(profile.name);
    expect(containerHeader()?.getAttribute('aria-description')).toBe(`${workers[0]!.name}\nImage: fixture`);
    stored = { ...stored, agents: [{ ...profile, name: 'Updated from another window', revision: 2 }] };
    await act(async () => publish(stored));
    expect(containerRow()?.textContent).toBe('Updated from another window');
    expect(containerHeader()?.textContent).toBe('Updated from another window');
    stored = { ...stored, agents: [profile] };
    await click('Refresh');
    expect(containerRow()?.textContent).toBe(profile.name);
    await render(screen('homies'));
    const selected = () => document.querySelector('[aria-label="Agent selection"] button');
    const header = () => document.querySelector('[aria-label="Agent details"] h2');
    expect(selected()?.getAttribute('aria-label')).toBe(profile.name);
    expect(document.querySelector('[aria-label^="Container connection:"]')?.getAttribute('aria-description')).toBe(`${workers[0]!.name} · running`);
    await click(profile.name);
    expect(header()?.textContent).toBe(profile.name);
    stored = { ...stored, agents: [{ ...profile, name: 'Renamed Specialist', revision: 2 }] };
    await act(async () => publish(stored));
    expect(header()?.textContent).toBe('Renamed Specialist');
    await click('All Homies');
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).toContain('Renamed Specialist');
    expect(document.querySelector('[aria-label^="Container connection:"]')?.getAttribute('aria-description')).toBe(`${workers[0]!.name} · running`);
    await render(screen('docker'));
    expect(containerRow()?.textContent).toBe('Renamed Specialist');
    expect(containerHeader()?.textContent).toBe('Renamed Specialist');
    await click(workers[1]!.name);
    expect(containerHeader()?.textContent).toBe(workers[1]!.name);
    await render(screen('homies'));
    await click('Renamed Specialist');
    expect(header()?.textContent).toBe('Renamed Specialist');
    stored = { ...stored, agents: [] };
    await act(async () => publish(stored));
    expect(document.querySelector('[aria-label="Agent selection"] button')).toBeNull();
    await render(screen('docker'));
    await click(workers[0]!.name);
    expect(containerRow()?.textContent).toBe(workers[0]!.name);
    expect(containerHeader()?.textContent).toBe(workers[0]!.name);
  });
});

test('agent names open the default screen and container indicators never navigate', async () => {
  const agent = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const unlinked = { ...agent, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Unlinked agent' };
  let workers = [
    { id: 'first', name: 'container-first', profileId: agent.id, state: 'running', image: 'fixture' },
    { id: 'second', name: 'container-second', profileId: agent.id, state: 'exited', image: 'fixture' },
  ];
  const inspections: string[] = [], runtimeAgents: string[] = [];
  const registryApi: AgentRegistryApi = {
    list: async () => ({ workspaceRoot: '/project', agents: [agent, unlinked] }), models: async () => [],
    save: async () => { throw Error('Navigation must not save profiles'); }, onDidChange: () => () => {},
    runtime: async request => {
      expect(request.action).toBe('status'); runtimeAgents.push(request.agentId);
      return { details: null };
    },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [{ id: 'test:local', name: 'local', supported: true, reason: null }] }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: workers }),
    details: async (_engine, id) => {
      inspections.push(id);
      return { agent: workers.find(worker => worker.id === id)!, ready: id === 'first', busy: false, authenticated: true,
        threadId: `thread-${id}`, error: null, logs: '', tasks: [] };
    },
    control: async () => { throw Error('Navigation must not control containers'); },
  };
  await withDOM(async ({ render, click }) => {
    await render(<AgentManagementViews api={api} registryApi={registryApi} view="homies" />);
    const nav = () => document.querySelector('[aria-label="Agent selection"]')!;
    expect(document.querySelector('[aria-label="Agent task"]')).toBeNull();
    expect(document.querySelector('[aria-label="Back to agent settings"]')).toBeNull();
    expect(nav().textContent).not.toContain('CONNECTED WORKER CONTAINERS');
    expect(nav().querySelectorAll('[data-agent-avatar]')).toHaveLength(2);
    expect(nav().querySelectorAll('button')).toHaveLength(4);
    expect(nav().querySelectorAll('[role="img"][aria-label^="Container connection:"]')).toHaveLength(2);
    expect(nav().querySelector('button button')).toBeNull();
    const indicator = nav().querySelector<HTMLElement>('[aria-label="Container connection: container-second"]')!;
    expect(indicator.getAttribute('aria-description')).toBe('container-second · exited');
    expect(indicator.tabIndex).toBe(-1);
    const before = inspections.length;
    await act(async () => { indicator.click(); });
    expect(inspections).toHaveLength(before);
    expect(document.querySelector('[aria-label="Agent task"]')).toBeNull();
    await click(agent.name);
    expect(document.querySelector('form[aria-label="Agent settings"]')).not.toBeNull();
    expect(runtimeAgents).toEqual([]);
    await click('Advanced');
    expect(runtimeAgents.at(-1)).toBe(agent.id);
    await click('Agent settings'); await click('All Homies');
    await click('Unlinked agent');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe(unlinked.name);
    await click('Advanced');
    expect(runtimeAgents.at(-1)).toBe(unlinked.id);
    await click('Agent settings'); await click('All Homies');
    workers = []; await click('Refresh');
    expect(nav().querySelectorAll('[aria-label^="Container connection:"]')).toHaveLength(0);
    expect(nav().querySelectorAll('[data-agent-avatar]')).toHaveLength(2);
  });
});

test('task list restores its position and keeps the opened result through refreshes', async () => {
  const task = (id: string, output = `output:${id}`): AgentTask => ({
    id, prompt: `Review ${id}\nAdditional context`, status: 'completed',
    createdAt: '2026-10-02T09:00:00Z', output, error: null,
  });
  await withDOM(async ({ render, click }) => {
    const screen = (tasks: AgentTask[]) => <AgentTaskResults tasks={tasks} loading={false} running />;
    await render(screen([task('newer'), task('older')]));
    const list = document.querySelector<HTMLElement>('[aria-label="Task result list"]')!;
    list.scrollTop = 80;
    await click('Open task: older');
    expect(list.hidden).toBe(true);
    const content = document.querySelector<HTMLElement>('[aria-label="Task result content"]')!;
    expect(content.textContent).toContain('output:older');
    content.scrollTop = 37;
    await render(screen([task('latest'), task('newer'), task('older', 'updated result')]));
    expect(document.querySelector('[aria-label="Task result content"]')).toBe(content);
    expect(content.textContent).toContain('updated result');
    expect(content.scrollTop).toBe(37);
    await click('Back to task list');
    expect(document.querySelector('[aria-label="Task result list"]')).toBe(list);
    expect(list.hidden).toBe(false);
    expect(list.scrollTop).toBe(80);
    expect(document.activeElement?.getAttribute('data-task-id')).toBe('older');
    await click('Open task: older');
    await render(screen([task('latest')]));
    expect(document.querySelector('[aria-label="Task result content"]')).toBeNull();
    expect(list.hidden).toBe(false);
    await render(screen([]));
    expect(list.textContent).toContain('No task results available.');
  });
});

test('task detail renders request and output Markdown and preserves error and empty fallbacks', async () => {
  const task: AgentTask = { id: 'markdown', prompt: '**Review** `failure-rate.ts`', status: 'completed',
    createdAt: '2026-10-02T09:00:00Z', error: null,
    output: '# Findings\n\n**Not a product defect.**\n\n- Input `0`\n- Input `10`\n\n'
      + '```ts\nconst result = 1 / 0;\n```\n\n| Input | Result |\n| --- | --- |\n| 0 | NaN |\n\n'
      + '[Reference](https://example.com)\n\n[Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>' };
  await withDOM(async ({ render, click }) => {
    const screen = (value: AgentTask) => <AgentTaskResults tasks={[value]} loading={false} running />;
    await render(screen(task));
    await click('Open task: markdown');
    const request = document.querySelector('[aria-label="Task request"]')!;
    const output = document.querySelector('[aria-label="Task output"]')!;
    expect(request.querySelector('strong')?.textContent).toBe('Review');
    expect(request.querySelector('code')?.textContent).toBe('failure-rate.ts');
    expect(output.querySelector('h1')?.textContent).toBe('Findings');
    expect(output.querySelector('strong')?.textContent).toBe('Not a product defect.');
    expect(output.querySelectorAll('ul > li')).toHaveLength(2);
    expect(output.querySelector('pre code')?.textContent).toBe('const result = 1 / 0;');
    expect(output.querySelector('tbody td')?.textContent).toBe('0');
    expect(output.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(output.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(output.querySelector('script')).toBeNull();
    await render(screen({ ...task, output: '', error: '**Failed** to inspect.' }));
    expect(document.querySelector('[role="alert"] strong')?.textContent).toBe('Failed');
    await render(screen({ ...task, output: '', error: null }));
    expect(output.textContent).toContain('No output yet.');
  });
});

test('agents can be created and assigned without an engine, edited, and recovered after a failed save', async () => {
  let stored: AgentRegistrySnapshot = { agents: [], workspaceRoot: '/projects/cheshi' };
  let failSave = false;
  const writes: SaveSpecialistAgent[] = [];
  const modelAccounts: string[] = [];
  const listeners = new Set<(value: AgentRegistrySnapshot) => void>();
  const registryApi: AgentRegistryApi = {
    models: async accountId => { modelAccounts.push(accountId); return specialistModels(); },
    list: async () => stored,
    onDidChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: async input => {
      writes.push(structuredClone(input));
      if (failSave) throw new Error('Could not save agent registry.');
      const agent = { ...specialistAgent((input.revision ?? 0) + 1), ...input.profile,
        assignments: input.assignment.assigned ? [{ workspaceRoot: stored.workspaceRoot, instructions: input.assignment.instructions, ...(input.assignment.permissions ? { permissions: input.assignment.permissions } : {}) }] : [] };
      stored = { ...stored, agents: [agent] };
      for (const listener of listeners) listener(stored);
      return { agentId: agent.id, snapshot: stored };
    },
  };
  const api: AgentManagementApi = { engines: async () => ({ engines: [], error: null }),
    snapshot: async engineId => ({ engineId, online: false, error: 'Offline', agents: [] }),
    details: async () => { throw new Error('No runtime should be contacted'); },
    control: async () => { throw new Error('No runtime should be started'); } };
  const accountsApi: Pick<CodexAccountsApi, 'list' | 'onDidChange'> = {
    list: async () => ({ activeId: 'default', profiles: [
      { id: 'default', label: 'Default account', email: 'first@example.test',
        login: { state: 'signed_in', error: null }, usage: { state: 'ready', authenticated: true, plan: null, rateLimits: [], error: null } },
      { id: 'fixture-account', label: 'Account 2', email: 'second@example.test',
        login: { state: 'signed_in', error: null }, usage: { state: 'ready', authenticated: true, plan: null, rateLimits: [], error: null } },
    ] }),
    onDidChange: () => () => {},
  };
  await withDOM(async ({ render, click }) => {
    const fill = async (label: string, value: string) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    const screen = (view: 'homies' | null) => <AgentManagementViews api={api} registryApi={registryApi} accountsApi={accountsApi} view={view} />;
    await render(screen('homies'));
    await click('New agent');
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Create agent');
    expect(document.querySelector('[aria-label="Allow agent file changes"]')?.getAttribute('aria-checked')).toBe('true');
    await click('Agent specialty');
    await click('Verification');
    expect(document.querySelector('[aria-label="Allow agent file changes"]')?.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[aria-label="Allow agent commands"]')?.getAttribute('aria-checked')).toBe('true');
    await click('Execution permission preset');
    await click('Review · Read only');
    expect(document.querySelector('[aria-label="Allow agent commands"]')?.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Agent instructions"]')?.value).toContain('Reproduce reported issues');
    await click('Agent account');
    await click('first@example.test');
    expect(document.querySelector('[aria-label="Agent account"]')?.textContent).toContain('first@example.test');
    await click('Agent account');
    await click('second@example.test');
    expect(document.querySelector('[aria-label="Agent account"]')?.textContent).toContain('second@example.test');
    await fill('Agent name', 'Cheshi developer');
    await fill('Agent instructions', 'Follow AGENTS.md and verify changes.');
    await fill('Project instructions', 'Work in a dedicated worktree.');
    await click('Agent model');
    await click('Fixture model');
    await click('Agent reasoning effort');
    await click('High');
    await click('Agent service tier');
    await click('Fast');
    await click('Agent model');
    await click('Small model');
    expect(document.querySelector('[aria-label="Agent reasoning effort"]')?.textContent).toContain('Low');
    expect(document.querySelector('[aria-label="Agent service tier"]')?.textContent).toContain('Standard');
    await click('Agent model');
    await click('Fixture model');
    expect(document.querySelector('[aria-label="Agent reasoning effort"]')?.textContent).toContain('Medium');
    await click('Agent reasoning effort');
    await click('High');
    await click('Agent service tier');
    await click('Fast');
    await click('Allow agent file changes');
    await click('Create agent');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ profile: { name: 'Cheshi developer', role: 'verification', model: 'model-fixture', accountId: 'fixture-account',
      reasoningEffort: 'high', serviceTier: 'priority', permissions: { fileWrite: false, commandExecution: false } },
      assignment: { assigned: true, instructions: 'Work in a dedicated worktree.', permissions: { fileWrite: true, commandExecution: false } } });
    expect(modelAccounts).toContain('default');
    expect(modelAccounts).toContain('fixture-account');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe('Cheshi developer');
    expect(document.querySelector('[aria-label="Agent task"]')).toBeNull();
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Agent settings');
    expect(document.querySelector('form')?.textContent).not.toContain('Open agent');
    await fill('Agent name', 'Updated developer');
    failSave = true;
    await click('Save agent');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save agent registry');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe('Updated developer');
    expect(stored.agents[0]?.name).toBe('Cheshi developer');
    failSave = false;
    await click('Assign agent to this project');
    await click('Save agent');
    expect(stored.agents[0]?.assignments).toEqual([]);
    expect(stored.agents[0]?.name).toBe('Updated developer');
    await render(screen(null));
    await render(screen('homies'));
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe('Updated developer');
    expect(document.querySelector('[aria-label="Agent model"]')?.textContent).toContain('Fixture model');
    expect(document.querySelector('[aria-label="Agent reasoning effort"]')?.textContent).toContain('High');
    expect(document.querySelector('[aria-label="Agent service tier"]')?.textContent).toContain('Fast');
    await click('Agent account');
    await click('first@example.test');
    expect(document.querySelector('[aria-label="Agent model"]')?.textContent).toContain('Runtime default');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Agent reasoning effort"]')?.disabled).toBe(true);
  });
  expect(listeners.size).toBe(0);
});

test('model catalogs ignore late account responses and recover from a failed load', async () => {
  const pending = registryDeferred<ReturnType<typeof specialistModels>>();
  let failed = true;
  const load = async (id: string) => {
    if (id === 'first') return pending.promise;
    if (id === 'failed' && failed) throw new Error('Catalog unavailable');
    return [specialistModels()[1]!];
  };
  function Catalog({ accountId }: { accountId: string | null }) {
    const catalog = useSpecialistModels(accountId, load);
    return <><output>{JSON.stringify(catalog)}</output><button onClick={catalog.retry}>Retry</button></>;
  }
  await withDOM(async ({ render, click }) => {
    await render(<Catalog accountId="first" />);
    await render(<Catalog accountId="second" />);
    await act(async () => { pending.resolve(specialistModels()); });
    expect(document.querySelector('output')?.textContent).toContain('small-fixture');
    expect(document.querySelector('output')?.textContent).not.toContain('model-fixture');
    await render(<Catalog accountId="failed" />);
    expect(document.querySelector('output')?.textContent).toContain('Catalog unavailable');
    failed = false;
    await click('Retry');
    expect(document.querySelector('output')?.textContent).not.toContain('Catalog unavailable');
    expect(document.querySelector('output')?.textContent).toContain('small-fixture');
    await render(<Catalog accountId={null} />);
    expect(document.querySelector('output')?.textContent).not.toContain('small-fixture');
  });
});

test('registered runtime starts explicitly and shows acknowledged tasks without replacing them during refresh', async () => {
  const { SpecialistRuntimePanel } = await import('../frontend/src/features/agents/SpecialistRuntimePanel');
  const { AgentRegistryModel } = await import('../frontend/src/features/agents/agentRegistryModel');
  const actions: string[] = [];
  const agent = specialistAgent();
  const ready = { agent: { id: 'worker', name: agent.name, image: 'worker', state: 'running' }, ready: true, busy: false,
    authenticated: true, threadId: 'thread', error: null, logs: '', tasks: [] };
  let started = false;
  const pending = registryDeferred<{ details: typeof ready }>();
  const registry = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [],
    save: async () => { throw Error('unused'); }, onDidChange: () => () => {}, runtime: async request => {
      actions.push(request.action);
      if (request.action === 'start') { started = true; return pending.promise; }
      return { details: started ? ready : null };
    } });
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistRuntimePanel assigned agent={agent} model={registry} engineId="docker:local"
        engines={[{ id: 'docker:local', name: 'local', supported: true, reason: null }]} onSettings={() => {}} />);
      expect(actions).toEqual(['status']);
      await ui.click('Start agent');
      expect(document.body.textContent).toContain('Processing…');
      expect((document.querySelector('[aria-label="Start agent"]') as HTMLButtonElement).disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('[aria-label="Agent settings"]')?.disabled).toBe(true);
      await act(async () => pending.resolve({ details: ready }));
      expect(document.body.textContent).toContain('Ready'); expect(document.body.textContent).toContain('Signed');
      await ui.click('Refresh agent');
      expect(actions).toEqual(['status', 'start', 'status']);
      expect(document.body.textContent).toContain('Ready');
    });
  } finally { registry.dispose(); }
});

test('engine disconnection preserves recovery details, disables actions, and recovers on refresh', async () => {
  const { SpecialistRuntimePanel } = await import('../frontend/src/features/agents/SpecialistRuntimePanel');
  const { AgentRegistryModel } = await import('../frontend/src/features/agents/agentRegistryModel');
  const agent = specialistAgent();
  let offline = false;
  const details = { agent: { id: 'worker', name: agent.name, image: 'worker', state: 'running' }, ready: true, busy: false,
    authenticated: true, threadId: 'thread', error: null, logs: '', tasks: [
      { id: 'previous', prompt: 'Previous result', status: 'unknown', createdAt: '2026-10-03', output: 'Keep this result', error: null },
    ] };
  const registry = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [],
    save: async () => { throw Error('unused'); }, onDidChange: () => () => {}, runtime: async request => {
      expect(request.action).toBe('status');
      return offline ? { details: null, unavailable: { kind: 'engine-unavailable', message: 'Engine disconnected; retrying.' } } : { details };
    } });
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistRuntimePanel assigned agent={agent} model={registry} engineId="docker:local"
        engines={[{ id: 'docker:local', name: 'local', supported: true, reason: null }]} onSettings={() => {}} />);
      expect(document.querySelector('textarea')).toBeNull();
      offline = true; await ui.click('Refresh agent');
      expect(document.body.textContent).toContain('Engine disconnected');
      expect(document.body.textContent).toContain('Previous result');
      expect(document.querySelector('textarea')).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="Start agent"]')?.disabled).toBe(true);
      expect(document.querySelector('button[type="submit"]')).toBeNull();
      offline = false; await ui.click('Refresh agent');
      expect(document.body.textContent).toContain('Ready');
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="Start agent"]')?.disabled).toBe(false);
      expect(document.querySelector('textarea')).toBeNull();
    });
  } finally { registry.dispose(); }
});

test('waiting collaboration is visible and can be stopped while the worker is idle', async () => {
  const { SpecialistRuntimePanel } = await import('../frontend/src/features/agents/SpecialistRuntimePanel');
  const { AgentRegistryModel } = await import('../frontend/src/features/agents/agentRegistryModel');
  const agent = specialistAgent();
  const details = { agent: { id: 'worker', name: agent.name, image: 'worker', state: 'running' }, ready: true, busy: false,
    authenticated: true, threadId: 'thread', error: null, logs: '',
    tasks: [{ id: 'waiting', prompt: 'Complete login', status: 'waiting', createdAt: '2026-10-03', output: 'Waiting for policy', error: null }] };
  const registry = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [],
    save: async () => { throw Error('unused'); }, onDidChange: () => () => {}, runtime: async request => {
      if (request.action === 'cancel') {
        expect(request.taskId).toBe('waiting'); details.tasks[0]!.status = 'interrupted';
      }
      return { details: structuredClone(details) };
    } });
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistRuntimePanel assigned agent={agent} model={registry} engineId="docker:local"
        engines={[{ id: 'docker:local', name: 'local', supported: true, reason: null }]} onSettings={() => {}} />);
      expect(document.body.textContent).toContain('Waiting for reply');
      await ui.click('Stop task');
      expect(document.body.textContent).toContain('interrupted');
      expect(document.querySelector('[aria-label="Stop task"]')).toBeNull();
    });
  } finally { registry.dispose(); }
});

test('Advanced preserves settings drafts and never starts or cancels a running task', async () => {
  const agent = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const actions: string[] = [];
  const worker = { id: 'worker', name: 'Worker', image: 'fixture', state: 'running', profileId: agent.id };
  const details = { agent: worker, ready: true, busy: true, authenticated: true, threadId: 'retained-thread',
    error: null, logs: '', tasks: [{ id: 'running-task', prompt: 'Continue work', status: 'running',
      createdAt: '2026-10-03', output: '', error: null }] };
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [{ id: 'docker:local', name: 'local', supported: true, reason: null }] }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: [worker] }),
    details: async () => details,
    control: async () => { throw Error('Navigation must not control the worker'); },
  };
  const registryApi: AgentRegistryApi = {
    list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [],
    save: async () => { throw Error('Navigation must not save settings'); }, onDidChange: () => () => {},
    runtime: async request => {
      actions.push(request.action);
      if (request.action !== 'status') throw Error('Navigation must not mutate worker tasks');
      return { details };
    },
  };
  await withDOM(async ({ render, click }) => {
    await render(<AgentManagementViews api={api} registryApi={registryApi} view="homies" />);
    await click(agent.name);
    const form = document.querySelector('form');
    await click('Advanced');
    expect(document.body.textContent).toContain('Working');
    await click('Agent settings');
    expect(document.querySelector('form[aria-label="Agent settings"]')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe(agent.name);
    expect(document.querySelector('[aria-label="Agent task"]')).toBeNull();
    expect(actions).toEqual(['status']);
    expect(document.querySelector('form')).toBe(form);
    await click('Advanced');
    expect(document.body.textContent).toContain('Working');
    expect(document.body.textContent).toContain('retained-thread');
    expect(document.querySelector('[aria-label="Open task: running-task"]')).not.toBeNull();
    expect(actions).toEqual(['status', 'status']);
  });
});

test('container deletion requires confirmation, preserves state on failure and retries the captured target', async () => {
  const id = 'a'.repeat(64);
  let workers = [{ id, name: 'Worker', image: 'fixture', state: 'running' }];
  let pending = registryDeferred<void>();
  const requests: unknown[] = [];
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [{ id: 'docker:local', name: 'local', supported: true, reason: null }] }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: workers }),
    details: async () => ({ agent: workers[0]!, ready: true, busy: false, authenticated: true, threadId: null, error: null, logs: 'retained log', tasks: [] }),
    control: async () => { throw new Error('unused'); },
    remove: async request => { requests.push(request); await pending.promise; workers = []; },
  };
  await withDOM(async ({ render, click }) => {
    await render(<AgentManagementViews api={api} view="docker" />);
    await click('Delete selected container');
    expect(document.querySelector('[aria-label="Also delete saved data"]')?.getAttribute('aria-checked')).toBe('false');
    await click('Cancel'); expect(requests).toHaveLength(0);
    await click('Delete selected container'); await click('Delete container');
    expect(requests).toEqual([{ engineId: 'docker:local', containerId: id, deleteData: false }]);
    expect(document.querySelector('[aria-label="Container log output"]')?.textContent).toBe('retained log');
    expect((document.querySelector('[aria-label="Close dialog"]') as HTMLButtonElement).disabled).toBe(true);
    await click('Deleting…'); expect(requests).toHaveLength(1);
    await act(async () => pending.reject(new Error('Volume cleanup failed. Retry.')));
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('cleanup failed');
    expect(document.querySelector('[aria-label="Container selection"]')?.textContent).toContain('Worker');
    pending = registryDeferred<void>();
    await click('Delete container');
    await act(async () => pending.resolve());
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('[aria-label="Container selection"]')?.textContent).not.toContain('Worker');
    expect(requests).toHaveLength(2);
  });
});

test('agent deletion preserves registration and shows application blocks until a successful retry', async () => {
  const profile = specialistAgent();
  let stored: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [profile] };
  const pending = registryDeferred<void>();
  let reply: unknown = { status: 'blocked', message: 'Open the task details and select Inspect application before deleting.' };
  const requests: unknown[] = [];
  const registryApi: AgentRegistryApi = {
    list: async () => stored, models: async () => [], onDidChange: () => () => {},
    save: async () => { throw new Error('unused'); },
    remove: async input => { requests.push(input); await pending.promise; unwrapAgentDeletion(reply); stored = { ...stored, agents: [] }; return stored; },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [] }),
    snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
    details: async () => { throw new Error('unused'); }, control: async () => { throw new Error('unused'); },
  };
  await withDOM(async ({ render, click }) => {
    await render(<AgentManagementViews api={api} registryApi={registryApi} view="homies" />);
    await click(`Delete agent: ${profile.name}`);
    await click('Also delete saved data'); await click('Delete agent');
    expect(requests).toEqual([{ id: profile.id, revision: profile.revision, deleteData: true }]);
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).toContain(profile.name);
    await act(async () => pending.resolve());
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('Inspect application');
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).toContain(profile.name);
    expect(document.querySelector('[aria-label="Also delete saved data"]')?.getAttribute('aria-checked')).toBe('true');
    reply = { status: 'deleted' };
    await click('Delete agent');
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).not.toContain(profile.name);
    expect(requests).toEqual(Array(2).fill({ id: profile.id, revision: profile.revision, deleteData: true }));
  });
});

test('row deletion targets only the chosen Homie and preserves the remaining registration', async () => {
  const selected = specialistAgent();
  const other = { ...specialistAgent(4), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Other specialist' };
  let stored: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [selected, other] };
  const pending = registryDeferred<void>();
  const requests: unknown[] = [];
  const registryApi: AgentRegistryApi = {
    list: async () => stored, models: async () => [], onDidChange: () => () => {},
    save: async () => { throw Error('Deletion must not save the open draft'); },
    remove: async input => {
      requests.push(input); await pending.promise;
      stored = { ...stored, agents: stored.agents.filter(agent => agent.id !== input.id) }; return stored;
    },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [] }),
    snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
    details: async () => { throw Error('unused'); }, control: async () => { throw Error('unused'); },
  };
  await withDOM(async ({ render, click }) => {
    await render(<AgentManagementViews api={api} registryApi={registryApi} view="homies" />);
    const list = document.querySelector('[aria-label="Agent selection"]');
    expect(document.querySelector('[aria-label="Delete selected agent"]')).toBeNull();
    expect(document.querySelectorAll('[aria-label="Agent selection"] button[aria-label^="Delete agent:"]')).toHaveLength(2);
    await click(`Delete agent: ${other.name}`);
    expect(document.querySelector('dialog')?.textContent).toContain(other.name);
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent === 'Cancel')!.click();
    });
    expect(requests).toHaveLength(0);
    expect(document.querySelector('[aria-label="Agent selection"]')).toBe(list);
    await click(`Delete agent: ${other.name}`); await click('Delete agent');
    expect(requests).toEqual([{ id: other.id, revision: other.revision, deleteData: false }]);
    expect([...document.querySelectorAll<HTMLButtonElement>('[aria-label="Agent selection"] button[aria-label^="Delete agent:"]')]
      .every(button => button.disabled)).toBe(true);
    await act(async () => pending.resolve());
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('[aria-label="Agent selection"]')).toBe(list);
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).toContain(selected.name);
    expect(document.querySelector('[aria-label="Agent selection"]')?.textContent).not.toContain(other.name);
  });
});

test('agent icon selection supports cancellation, rerolls and persistence in the unified row', async () => {
  const profile = specialistAgent();
  let stored: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [profile] };
  const writes: SaveSpecialistAgent[] = [];
  const registryApi: AgentRegistryApi = {
    list: async () => stored, models: async () => [], onDidChange: () => () => {},
    save: async input => {
      writes.push(input);
      stored = { ...stored, agents: [{ ...profile, ...input.profile, revision: profile.revision + 1 }] };
      return { agentId: profile.id, snapshot: stored };
    },
  };
  const worker = { id: 'worker', profileId: profile.id, name: 'worker-internal-name', image: 'fixture', state: 'running' };
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [{ id: 'test:local', name: 'local', supported: true, reason: null }] }),
    snapshot: async engineId => ({ engineId, online: true, error: null, agents: [worker] }),
    details: async () => ({ agent: worker, ready: true, busy: false, authenticated: true, threadId: null, error: null, logs: '', tasks: [] }),
    control: async () => { throw new Error('Icon changes must not control workers'); },
  };
  await withDOM(async ({ render, click }) => {
    const screen = () => <AgentManagementViews api={api} registryApi={registryApi} view="homies" />;
    await render(screen());
    const icons = () => Array.from(document.querySelectorAll('[aria-label="Agent selection"] [data-agent-avatar]')).map(e => e.getAttribute('data-agent-avatar'));
    expect(icons()).toHaveLength(1);
    expect(document.querySelector('[aria-label="Container connection: worker-internal-name"]')).not.toBeNull();
    await click(profile.name);
    const preview = () => document.querySelector('[aria-label="Choose agent icon"] [data-agent-avatar]')?.getAttribute('data-agent-avatar');
    const initial = preview();
    await click('Choose agent icon');
    expect(document.querySelectorAll('[aria-label="Icon characters"] button')).toHaveLength(24);
    expect(document.querySelectorAll('[aria-label="Icon colors"] button')).toHaveLength(8);
    await click('Character crab'); await click('Color pink');
    expect(document.querySelector('[aria-label="Character crab"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(preview()).toBe(initial);
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent === 'Cancel')!.click();
    });
    expect(preview()).toBe(initial); expect(writes).toHaveLength(0);
    await click('Choose agent icon');
    await click('Randomize agent icon'); await click('Use icon');
    expect(preview()).not.toBe(initial);
    await click('Choose agent icon'); await click('Character crab'); await click('Color pink'); await click('Use icon');
    expect(preview()).toBe('crab:pink');
    await click('Save agent');
    expect(writes[0]!.profile.avatar).toEqual({ character: 'crab', color: 'pink' });
    await click('All Homies');
    expect(icons()).toEqual(['crab:pink']);
    await click('Refresh'); expect(icons()).toEqual(['crab:pink']);
    await render(<div />); await render(screen());
    expect(icons()).toEqual(['crab:pink']);
    await click(profile.name); expect(preview()).toBe('crab:pink');
  });
});

test('instruction file controls preserve draft links through cancellation and errors and save each scope separately', async () => {
  const profile = specialistAgent();
  let stored: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [profile] };
  let selected: string[] = [], openError = false;
  const writes: SaveSpecialistAgent[] = [], opened: string[] = [];
  const registryApi: AgentRegistryApi = {
    list: async () => stored, models: async () => [], onDidChange: () => () => {},
    selectInstructionFiles: async () => selected,
    openInstructionFile: async path => { if (openError) throw new Error('File is unavailable'); opened.push(path); },
    save: async input => {
      writes.push(input);
      stored = { ...stored, agents: [{ ...profile, ...input.profile, revision: profile.revision + writes.length,
        assignments: [{ workspaceRoot: '/project', instructions: input.assignment.instructions, instructionFiles: input.assignment.instructionFiles }] }] };
      return { agentId: profile.id, snapshot: stored };
    },
  };
  const api: AgentManagementApi = {
    engines: async () => ({ error: null, engines: [] }),
    snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
    details: async () => { throw new Error('unused'); }, control: async () => { throw new Error('unused'); },
  };
  await withDOM(async ({ render, click }) => {
    const screen = () => <AgentManagementViews api={api} registryApi={registryApi} view="homies" />;
    await render(screen()); await click(profile.name);
    await click('Link common instruction files'); expect(writes).toHaveLength(0);
    selected = ['/common/RULES.md']; await click('Link common instruction files'); await click('Link common instruction files');
    expect(document.querySelectorAll('[aria-label="Common instruction files"] [aria-label="Open /common/RULES.md"]')).toHaveLength(1);
    await click('Assign agent to this project');
    selected = ['/project/AGENTS.md']; await click('Link project instruction files');
    expect(document.querySelector('[aria-label="Project instruction files"]')?.textContent).toContain('/project/AGENTS.md');
    await click('Open /common/RULES.md'); expect(opened).toEqual(['/common/RULES.md']);
    openError = true; await click('Open /project/AGENTS.md');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('File is unavailable');
    await click('Save agent');
    expect(writes[0]?.profile.instructionFiles).toEqual(['/common/RULES.md']);
    expect(writes[0]?.assignment.instructionFiles).toEqual(['/project/AGENTS.md']);
    await render(<div />); await render(screen()); await click(profile.name);
    expect(document.querySelector('[aria-label="Open /project/AGENTS.md"]')).not.toBeNull();
    await click('Unlink /project/AGENTS.md'); await click('Save agent');
    expect(writes[1]?.assignment.instructionFiles).toEqual([]);
    expect(writes[1]?.profile.instructionFiles).toEqual(['/common/RULES.md']);
  });
});

test('task inspection shows blocked progress, independent failures and refreshes without losing selection', async () => {
  const { inspectAgentTasks } = await import('../lib/agent-management/task-inspection.mts');
  const base = { id: 'inspect', prompt: 'Implement login', status: 'interrupted', createdAt: '2026-10-03', output: 'Implementation summary', error: 'Need verification',
    goal: { phase: 'blocked', turns: 2, verificationRequired: true, criteria: [{ criterion: 'Reject bad password', met: true, evidence: 'Agent claim' }],
      decisions: [{ action: 'blocked', progress: 'Login written', reason: 'Verifier found a failure', nextAction: 'Fix status code',
        criteria: [{ criterion: 'Reject bad password', met: true, evidence: 'Agent claim' }] }], pending: null } };
  const result = { verdicts: [{ criterion: 'Reject bad password', verdict: 'fail', reason: 'Returned 200', evidenceIds: ['receipt'] }],
    evidence: [{ id: 'receipt', kind: 'command', detail: 'bun test login', output: 'expected 401', exitCode: 1, successful: false }] };
  const records = { peers: [{ id: 'verify', name: 'Verifier', role: 'verification' }], outgoing: [], consumed: ['review'], acknowledged: [],
    incoming: [{ id: 'review', kind: 'verification_result', from: 'verify', to: 'dev', taskId: 'inspect', questionId: 'request', text: JSON.stringify(result) }] };
  await withDOM(async ({ render, click }) => {
    const screen = (output: string) => <AgentTaskResults tasks={inspectAgentTasks({ tasks: [{ ...base, output }], collaboration: records, recall: [] })} loading={false} running />;
    await render(screen('Implementation summary'));
    expect(document.querySelector('h2')?.textContent).toBe('TASKS');
    await click('Open task: inspect');
    expect(document.querySelector('[aria-label="Task status"]')?.textContent).toContain('blocked');
    expect(document.querySelector('[aria-label="Completion criteria"]')?.textContent).toContain('Reported met');
    expect(document.querySelector('[aria-label="Independent verification"]')?.textContent).toContain('fail');
    expect(document.querySelector('[aria-label="Independent verification"]')?.textContent).toContain('expected 401');
    expect(document.querySelector('[aria-label="Task progress"]')?.textContent).toContain('Fix status code');
    expect(document.querySelector('[aria-label="Task memory recall"]')?.textContent).toContain('No retained recall entries');
    await render(screen('Refreshed evidence'));
    expect(document.querySelector('[aria-label="Task output"]')?.textContent).toContain('Refreshed evidence');
    await click('Back to task list');
    expect(document.activeElement?.getAttribute('data-task-id')).toBe('inspect');
  });
});

test.each(['consultation', 'verification'])('%s inspection uses the saved room, blocks duplicate clicks and preserves unknown on rejection', async kind => {
  const { SpecialistRuntimePanel } = await import('../frontend/src/features/agents/SpecialistRuntimePanel');
  const { AgentRegistryModel } = await import('../frontend/src/features/agents/agentRegistryModel');
  const { inspectAgentTasks } = await import('../lib/agent-management/task-inspection.mts');
  const agent = specialistAgent();
  const tasks = inspectAgentTasks({ tasks: [{ id: 'q_question', [kind]: 'question', roomId: 'room', status: 'unknown',
    prompt: 'Consult', output: '', error: 'Unconfirmed', createdAt: '2026-10-03' }] });
  const details = { agent: { id: 'worker', name: agent.name, image: 'worker', state: 'running' }, ready: true, busy: false,
    authenticated: true, threadId: null, error: null, logs: '', tasks };
  const calls: unknown[] = [];
  let attempt = registryDeferred<{ details: typeof details }>();
  const registry = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [],
    save: async () => { throw Error('unused'); }, onDidChange: () => () => {}, runtime: async request => {
      if (request.action === 'recover') { calls.push(request); return attempt.promise; }
      return { details };
    } });
  try {
    await withDOM(async ui => {
      await ui.render(<SpecialistRuntimePanel assigned agent={agent} model={registry} engineId="docker:local"
        engines={[{ id: 'docker:local', name: 'local', supported: true, reason: null }]} onSettings={() => {}} />);
      await ui.click('Open task: q_question');
      expect(document.querySelector(kind === 'verification' ? '[aria-label="Verification recovery"]' : '[aria-label="Consultation recovery"]')).not.toBeNull();
      if (kind === 'verification') expect(document.body.textContent).toContain('execution ending alone does not mean verification passed');
      await ui.click('Inspect execution'); await ui.click('Inspect execution');
      expect(calls).toEqual([{ agentId: agent.id, engineId: 'docker:local', action: 'recover', taskId: 'q_question', roomId: 'room' }]);
      await act(async () => attempt.reject(new Error('The saved turn has not ended.')));
      expect(document.body.textContent).toContain('The saved turn has not ended.');
      expect(document.body.textContent).toContain('unknown');
      attempt = registryDeferred<{ details: typeof details }>();
      await ui.click('Inspect execution');
      await act(async () => attempt.resolve({ details: { ...details, tasks: tasks.map(task => ({ ...task, status: 'interrupted', output: 'Recovered consultation', error: null,
        recovery: { threadId: 'saved-thread', turnId: 'saved-turn', status: 'interrupted' as const, checkedAt: '2026-10-03T00:00:00Z' } })) } }));
      expect(document.body.textContent).toContain('Recovered consultation');
      expect(document.querySelector('[aria-label="Execution inspection"]')?.textContent).toContain('saved-turn');
      expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Inspect execution')).toBe(false);
    });
  } finally { registry.dispose(); }
});
