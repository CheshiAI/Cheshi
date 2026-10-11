import { expect, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { WorkerWorkspace, type WorkerWorkspaceHandle } from '../frontend/src/features/shell/WorkerWorkspace';
import type { AgentChatsApi, ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import type { AgentRegistryApi } from '../shared/agent-registry';
import type { AgentManagementApi } from '../shared/agent-management';
import { specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

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
    const open = () => document.querySelector('[aria-label="Manage Homies"]')?.getAttribute('aria-expanded');
    await ui.click('Manage Homies');
    expect(open()).toBe('true');
    expect(document.querySelector('[aria-label="Room participation"]')).not.toBeNull();
    await ui.click('Close Homies');
    expect(open()).toBe('false');
    await ui.click('Manage Homies');
    const panel = document.querySelector('[aria-label="Homies sidebar"]')!;
    await act(async () => panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(open()).toBe('false');
    await ui.click(`Manage Homie: ${agent.name}`);
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(true);
    expect(document.querySelector('[aria-label="Agent details"]')).not.toBeNull();
    await ui.click('All Homies');
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
