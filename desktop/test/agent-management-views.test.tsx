import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { AgentTaskResults } from '../frontend/src/features/agents/AgentTaskResults';
import type { AgentManagementApi, AgentTask } from '../shared/agent-management';
import type { AgentRegistryApi, AgentRegistrySnapshot, SaveSpecialistAgent } from '../shared/agent-registry';
import { registryDeferred, specialistAgent, specialistModels } from './agent-registry-fixtures';
import type { CodexAccountsApi } from '../shared/codex-accounts';
import { useSpecialistModels } from '../frontend/src/features/agents/SpecialistModelSettings';

async function withDOM(run: (ui: { render(node: ReactNode): Promise<void>; click(label: string): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node,
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
    const screen = (view: 'docker' | 'agents' | null) => <AgentManagementViews api={api} view={view} />;
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
    await render(screen('agents'));
    expect(document.querySelector('main')?.getAttribute('aria-label')).toBe('Agents');
    expect(document.querySelector('[aria-label="Execution engine"]')).toBeNull();
    expect(document.querySelector('[aria-label="Container logs"]')).toBeNull();
    expect([...document.querySelectorAll('button')].some(button => ['Start', 'Stop', 'Restart'].includes(button.textContent ?? ''))).toBe(false);
    expect(document.querySelector('[aria-label="Task result content"]')).toBeNull();
    await click('Open task: task-second');
    expect(document.querySelector('[aria-label="Task result content"]')?.textContent).toContain('result:second');
    await click('Back to task list');
    expect(document.querySelector('[aria-label="Task result content"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agent status"]')?.textContent).toContain('test:two/second');
    expect(document.querySelector('[aria-label="Agent status"]')?.textContent).toContain('Signed');
    expect(document.querySelector('button[aria-label="Agent"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agent selection"] [aria-current="page"]')?.getAttribute('aria-label')).toBe('Worker second');
    await click('Worker first');
    expect(document.querySelector('[aria-label="Agent status"]')?.textContent).toContain('test:two/first');
    expect(document.querySelector('[aria-label="Agent status"]')?.textContent).toContain('Not signed in');
    expect(document.querySelector('[aria-label="Task result content"]')).toBeNull();
    await click('Open task: task-first');
    expect(document.querySelector('[aria-label="Task result content"]')?.textContent).toContain('result:first');
    await click('Worker second');
    expect(document.querySelector('[aria-label="Agent selection"] [aria-current="page"]')?.getAttribute('aria-label')).toBe('Worker second');
    expect(document.querySelector('[aria-label="Task result content"]')).toBeNull();
    await click('Open task: task-second');
    const beforeRefresh = inspections.length;
    await click('Refresh');
    expect(inspections.length).toBe(beforeRefresh + 1);
    expect(inspections.at(-1)).toBe('test:two/second');
    expect(discoveries).toBe(1);
    expect(document.querySelector('[aria-label="Task result content"]')?.textContent).toContain('result:second');
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
    expect(output.querySelector('strong')?.textContent).toBe('Failed');
    await render(screen({ ...task, output: '', error: null }));
    expect(output.textContent).toBe('No output yet.');
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
        assignments: input.assignment.assigned ? [{ workspaceRoot: stored.workspaceRoot, instructions: input.assignment.instructions }] : [] };
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
    const screen = (view: 'agents' | null) => <AgentManagementViews api={api} registryApi={registryApi} accountsApi={accountsApi} view={view} />;
    await render(screen('agents'));
    await click('New agent');
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Create agent');
    await click('Agent specialty');
    await click('Verification');
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
      reasoningEffort: 'high', serviceTier: 'priority', permissions: { fileWrite: true, commandExecution: false } },
      assignment: { assigned: true, instructions: 'Work in a dedicated worktree.' } });
    expect(modelAccounts).toContain('default');
    expect(modelAccounts).toContain('fixture-account');
    expect(document.querySelector('[aria-label="Agent selection"] [aria-current="page"]')?.getAttribute('aria-label')).toBe('Cheshi developer');
    expect(document.querySelector('form')?.getAttribute('aria-label')).toBe('Agent settings');
    expect(document.querySelector('form')?.textContent).toContain('Open agent');
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
    await render(screen('agents'));
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
      await ui.render(<SpecialistRuntimePanel agent={agent} model={registry} engineId="docker:local"
        engines={[{ id: 'docker:local', name: 'local', supported: true, reason: null }]} onSettings={() => {}} />);
      expect(actions).toEqual(['status']);
      await ui.click('Start agent');
      expect(document.body.textContent).toContain('Processing…');
      expect((document.querySelector('[aria-label="Start agent"]') as HTMLButtonElement).disabled).toBe(true);
      await act(async () => pending.resolve({ details: ready }));
      expect(document.body.textContent).toContain('Ready'); expect(document.body.textContent).toContain('Signed');
      await ui.click('Refresh agent');
      expect(actions).toEqual(['status', 'start', 'status']);
      expect(document.body.textContent).toContain('Ready');
    });
  } finally { registry.dispose(); }
});
