import { expect, test } from 'bun:test';
import { act } from 'react';
import { AgentManagementViews } from '../frontend/src/features/shell/AgentManagementViews';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { withDOM } from './agent-chats-test-dom';
import { specialistAgent, registryDeferred } from './agent-registry-fixtures';
import type { AgentChatsApi, ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import type { AgentManagementApi } from '../shared/agent-management';
import type { AgentRegistryApi } from '../shared/agent-registry';

function fixture() {
  const first = { ...specialistAgent(), name: 'Development', accountId: 'one', assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  const second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Review', accountId: 'two' };
  const agents = [first, second];
  let snapshot: ChatsSnapshot = { rooms: [{ id: 'room', name: 'Test work', workspace: '/project', engineId: 'docker:test',
    members: [{ id: first.id, name: first.name, accountId: first.accountId }], defaultAgentId: first.id, createdAt: '2026-10-06T00:00:00Z' }], messages: [] };
  let fail = false;
  const requests: ChatsRequest[] = [];
  const chatsApi: AgentChatsApi = { request: async input => {
    requests.push(input);
    if (input.action === 'participants') {
      if (fail) throw Error('Save failed');
      const room = snapshot.rooms[0]!;
      snapshot = { ...snapshot, rooms: [{ ...room, members: input.members.map(id => {
        const agent = agents.find(item => item.id === id)!; return { id, name: agent.name, accountId: agent.accountId };
      }), defaultAgentId: input.defaultAgentId }] };
    }
    return snapshot;
  } };
  const registryApi: AgentRegistryApi = { list: async () => ({ workspaceRoot: '/project', agents }), models: async () => [], save: async () => { throw Error('Participation must not change the Homie profile'); }, onDidChange: () => () => {} };
  const api: AgentManagementApi = { engines: async () => ({ engines: [], error: null }),
    snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
    details: async () => { throw Error('No worker execution expected'); }, control: async () => { throw Error('No worker control expected'); } };
  return { first, second, agents, api, registryApi, chatsApi, requests, snapshot: () => snapshot,
    fail: (value: boolean) => { fail = value; }, replace: (next: ChatsSnapshot) => { snapshot = next; } };
}
const checkbox = (name: string) => document.querySelector<HTMLInputElement>(`[aria-label="Participate: ${name}"]`)!;
const selection = { agentId: null, roomId: 'room' };

test('Homies edits participation in its list, saves additions and removals, and keeps settings central', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" selectionRequest={selection} {...f} />);
    expect(checkbox('Development').checked).toBe(true);
    expect(checkbox('Development').disabled).toBe(false);
    await act(async () => { checkbox('Review').click(); });
    expect(f.requests.every(item => item.action === 'list')).toBe(true);
    await ui.click('Review');
    expect(document.querySelector('[aria-label="Agent details"]')).not.toBeNull();
    await ui.click('All Homies');
    expect(checkbox('Review').checked).toBe(true);
    await act(async () => { checkbox('Development').click(); });
    await ui.click('Save participants');
    expect(f.requests.filter(item => item.action === 'participants')).toEqual([{
      action: 'participants', roomId: 'room', members: [f.second.id], defaultAgentId: f.second.id,
      expectedMembers: [f.first.id], expectedDefaultAgentId: f.first.id,
    }]);
    expect(checkbox('Development').checked).toBe(false);
    expect(document.querySelector(`[aria-label="${f.first.name}"]`)).not.toBeNull();
    expect(document.querySelector('[aria-label^="Delete agent:"]')).toBeNull();
    await ui.click('Homie actions: Development');
    expect(document.querySelector('[role="menuitem"][aria-label="Delete agent: Development"]')).not.toBeNull();
  });
});

test('default Homie menu connects the shell backdrop and keeps selection in the participation draft until saved', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<div className="app-shell">
      <AgentManagementViews view="homies" selectionRequest={selection} {...f} />
      <footer>Workspace status</footer>
    </div>);
    await act(async () => { checkbox('Review').click(); });
    await ui.click('Default Homie');
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(document.querySelector('.app-shell')!.contains(menu)).toBe(false);
    const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.find(option => option.textContent === 'Development')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => { options.find(option => option.textContent === 'Review')!.click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(menu.hasAttribute('data-regional-blur-surface')).toBe(false);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Default Homie"]')!;
    expect(trigger.textContent).toBe('Review');
    expect(document.activeElement).toBe(trigger);
    expect(f.snapshot().rooms[0]!.defaultAgentId).toBe(f.first.id);
    await ui.click('Save participants');
    expect(f.snapshot().rooms[0]!.defaultAgentId).toBe(f.second.id);
  });
});

test('participation retains the draft on failure and prevents duplicate saves while waiting for acknowledgement', async () => {
  const f = fixture(), gate = registryDeferred<ChatsSnapshot>();
  const request = f.chatsApi.request;
  let waiting = false, pendingCalls = 0;
  f.chatsApi.request = input => {
    if (waiting && input.action === 'participants') { pendingCalls++; return gate.promise; }
    return request(input);
  };
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" selectionRequest={selection} {...f} />);
    await act(async () => { checkbox('Review').click(); });
    f.fail(true); await ui.click('Save participants');
    expect(document.body.textContent).toContain('Save failed');
    expect(checkbox('Review').checked).toBe(true);
    expect(f.snapshot().rooms[0]!.members).toHaveLength(1);
    waiting = true; await ui.click('Save participants');
    expect(checkbox('Review').disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Homie actions: Review"]')?.disabled).toBe(true);
    await ui.click('Saving…'); expect(pendingCalls).toBe(1);
    f.fail(false);
    const result = await request({ action: 'participants', roomId: 'room', members: [f.first.id, f.second.id], defaultAgentId: f.first.id,
      expectedMembers: [f.first.id], expectedDefaultAgentId: f.first.id });
    await act(async () => { gate.resolve(result); });
    expect(checkbox('Review').checked).toBe(true);
    expect(document.body.textContent).not.toContain('Save failed');
  });
});

test('concurrent membership changes require reload and rooms without context show only management', async () => {
  const f = fixture();
  await withDOM(async ui => {
    await ui.render(<AgentManagementViews view="homies" selectionRequest={selection} {...f} />);
    await act(async () => { checkbox('Review').click(); });
    const room = f.snapshot().rooms[0]!;
    f.replace({ ...f.snapshot(), rooms: [{ ...room, members: [...room.members, { id: f.second.id, accountId: 'two', name: 'Review' }], defaultAgentId: f.second.id }] });
    await act(async () => { window.dispatchEvent(new window.Event('focus')); });
    expect(document.body.textContent).toContain('Participants changed');
    await ui.click('Save participants');
    expect(f.requests.some(item => item.action === 'participants')).toBe(false);
    await ui.click('Reload participants');
    expect(document.body.textContent).not.toContain('Participants changed');
    await ui.render(<AgentManagementViews view="homies" selectionRequest={{ agentId: null }} {...f} />);
    expect(document.querySelector('[aria-label="Room participation"]')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

test('removed Homies retain their historical display names and are excluded from header participants', async () => {
  const f = fixture(), room = f.snapshot().rooms[0]!;
  f.replace({ rooms: [{ ...room, formerMembers: [{ id: f.second.id, accountId: 'two', name: 'Old reviewer' }] }], messages: [{
    id: 'old', roomId: 'room', threadId: null, sender: f.second.id, recipient: null, kind: 'message', text: 'Past review', createdAt: room.createdAt,
  }] });
  await withDOM(async ui => {
    await ui.render(<ChatsView active api={f.chatsApi} />);
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).toContain('Old reviewer');
    expect(document.querySelector('[aria-label="Worker"] header')?.textContent).not.toContain('Old reviewer');
    expect(document.querySelector('[aria-label="Room tools"] [aria-label="Room participants"]')).toBeNull();
  });
});
