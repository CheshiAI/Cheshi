import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import type { AgentManagementApi } from '../shared/agent-management';

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
  let discoveries = 0, openDocker = 0;
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
      return { agent: workers.find(item => item.id === id)!, ready: true, busy: false, authenticated: true,
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
    const screen = (view: 'docker' | 'agents' | null) => <AgentManagementViews api={api} view={view} onOpenDocker={() => { openDocker++; }} />;
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
    expect(document.querySelector('[aria-label="Task results"]')?.textContent).toContain('result:second');
    expect(document.querySelector('[aria-label="Agent status"]')?.textContent).toContain('test:two/second');
    await selectWithBlur('Agent', 'Worker second');
    await selectWithBlur('Task result', 'task-second · completed');
    await click('Docker settings'); expect(openDocker).toBe(1);
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
