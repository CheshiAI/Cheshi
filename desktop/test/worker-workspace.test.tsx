import { expect, mock, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { WorkerWorkspace, type WorkerWorkspaceHandle } from '../frontend/src/features/shell/WorkerWorkspace';
import type { SplitLayoutNode } from '../frontend/src/shared/ui/splitPaneModel';
import type { AgentChatsApi, ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import type { AgentRegistryApi } from '../shared/agent-registry';
import type { AgentManagementApi } from '../shared/agent-management';
import { specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

mock.module('../frontend/src/shared/ui/SplitPaneLayout.module.css', () => ({ default: { split: 'split', region: 'region', separator: 'separator' } }));
const { WorkspaceEditorSplit } = await import('../frontend/src/features/shell/WorkspaceEditorSplit');

test('Homies opens, closes and edits locally without rendering shell siblings or losing the conversation draft', async () => {
  const agent = { ...specialistAgent(), accountId: 'account', assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const snapshot: ChatsSnapshot = { rooms: [{ id: 'room', name: 'Work', workspace: '/project', engineId: 'docker:test',
    members: [{ id: agent.id, name: agent.name, accountId: agent.accountId }], defaultAgentId: agent.id, createdAt: '2026-10-06T00:00:00Z' }], messages: [] };
  const requests: ChatsRequest[] = [];
  const api: AgentChatsApi = { request: async request => { requests.push(request); return snapshot; } };
  const registryApi: AgentRegistryApi = { list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], onDidChange: () => () => {}, save: async () => { throw Error('Do not save settings in this test'); } };
  const managementApi: AgentManagementApi = { engines: async () => ({ engines: [], error: null }),
    snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
    details: async () => { throw Error('No container expected'); }, control: async () => { throw Error('No control expected'); } };
  let shellRenders = 0, siblingRenders = 0;
  function Sibling() { siblingRenders++; return <aside>Unrelated workspace view</aside>; }
  function Shell() {
    shellRenders++;
    const worker = useRef<WorkerWorkspaceHandle>(null);
    const [view, setView] = useState<'chats' | null>('chats');
    const [review, setReview] = useState<string | null>(null);
    const closeReview = () => { worker.current?.closeHomies(); setReview(null); };
    return <>
      <Sibling />
      <button onClick={() => { closeReview(); setView(null); }}>Leave Worker</button>
      <button onClick={() => { closeReview(); setView('chats'); }}>Return to Worker</button>
      <output>{review}</output>
      <WorkerWorkspace ref={worker} view={view} onBeforeOpenHomies={closeReview} onOpenRoom={closeReview}
        api={api} registryApi={registryApi} managementApi={managementApi} />
    </>;
  }
  await withDOM(async ui => {
    await ui.render(<Shell />);
    await ui.type('Message', 'Keep this draft');
    const baseline = { shell: shellRenders, sibling: siblingRenders };
    const timeline = document.querySelector('[aria-label="Room messages"]');
    const open = () => document.querySelector(`[aria-label="Open Homie: ${agent.name}"]`)?.getAttribute('aria-expanded');
    await ui.click(`Open Homie: ${agent.name}`);
    expect(open()).toBe('true');
    expect(document.querySelector('[aria-label="Room participation"]')).not.toBeNull();
    await ui.click('Close Homies');
    expect(open()).toBe('false');
    await ui.click(`Open Homie: ${agent.name}`);
    const panel = document.querySelector('[aria-label="Homies sidebar"]')!;
    await act(async () => panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(open()).toBe('false');
    await ui.click(`Open Homie: ${agent.name}`);
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(false);
    expect(document.querySelector('[aria-label="Agent details"]')).not.toBeNull();
    expect(Boolean(panel.querySelector('[aria-label="Agent details"]'))).toBe(true);
    await ui.click(`Open Homie: ${agent.name}`);
    expect(open()).toBe('false');
    await ui.click(`Open Homie: ${agent.name}`);
    expect(open()).toBe('true');
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(false);
    expect({ shell: shellRenders, sibling: siblingRenders }).toEqual(baseline);
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep this draft');
    expect(requests.filter(request => request.action === 'list')).toHaveLength(1);
    await ui.click('Leave Worker');
    await ui.click('Return to Worker');
    expect(open()).toBe('false');
    expect(document.querySelector('[aria-label="Agent selection"]')).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep this draft');
  });
});

test('Worker splits and maximizes its workspace pane without replacing the room or draft', async () => {
  const snapshot: ChatsSnapshot = { rooms: [{ id: 'room', name: 'Work', workspace: '/project', engineId: 'docker:test',
    members: [{ id: 'homie', name: 'Homie', accountId: 'account' }], defaultAgentId: 'homie', createdAt: '2026-10-06T00:00:00Z' }], messages: [] };
  const api: AgentChatsApi = { request: async () => snapshot };
  const opened: string[] = [];
  function Shell() {
    const [layout, setLayout] = useState<SplitLayoutNode | null>(null);
    return <WorkspaceEditorSplit mode="primary" workerPrimary layout={layout} onLayoutChange={setLayout}
      onOpenPane={pane => opened.push(pane)} editor={<div>Explorer pane</div>} terminal={<div>Terminal pane</div>}
      worker={<WorkerWorkspace view="chats" onBeforeOpenHomies={() => {}} api={api} />}><textarea aria-label="Codex draft" defaultValue="Keep Codex draft" />
    </WorkspaceEditorSplit>;
  }
  await withDOM(async ui => {
    window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 1200, 800);
    await ui.render(<Shell />);
    await ui.type('Message', 'Keep this Worker draft');
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    const timeline = document.querySelector('[aria-label="Room messages"]');
    const visiblePanes = () => [...document.querySelectorAll('[data-workspace-pane]')]
      .filter(pane => !pane.closest('[hidden]')).map(pane => pane.getAttribute('data-workspace-pane'));
    const maximize = () => document.querySelector<HTMLButtonElement>('main[aria-label="Worker"] [aria-label="Maximize pane"]')!;
    expect(maximize().disabled).toBe(true);
    expect(document.querySelector('main[aria-label="Worker"] [aria-label="Move workspace pane"]')?.getAttribute('draggable')).toBe('true');
    await ui.click('Split area right');
    const choices = [...document.querySelectorAll<HTMLButtonElement>('dialog button')];
    expect(choices.find(button => button.textContent?.startsWith('Worker'))?.disabled).toBe(true);
    const codex = choices.find(button => button.textContent?.startsWith('Session'))!;
    expect(codex.disabled).toBe(false);
    await act(async () => codex.click());
    expect(opened).toEqual(['primary']);
    expect(visiblePanes()).toEqual(['worker', 'primary']);
    expect(maximize().disabled).toBe(false);
    await ui.click('Maximize pane');
    expect(visiblePanes()).toEqual(['worker']);
    await ui.click('Restore pane size');
    expect(visiblePanes()).toEqual(['worker', 'primary']);
    await ui.click('Split area down');
    const terminal = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent?.startsWith('Terminal'))!;
    await act(async () => terminal.click());
    expect(opened).toEqual(['primary', 'terminal']);
    expect(visiblePanes()).toEqual(['worker', 'terminal', 'primary']);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Codex draft"]')?.value).toBe('Keep Codex draft');
    expect(document.querySelector('[aria-label="Message"]')).toBe(draft);
    expect(draft.value).toBe('Keep this Worker draft');
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect(document.querySelector('main[aria-label="Worker"] section[aria-label="Work"]')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Phone calls"]')?.disabled).toBe(false);
  });
});
