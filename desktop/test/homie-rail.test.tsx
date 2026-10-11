import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { WorkerWorkspace } from '../frontend/src/features/shell/WorkerWorkspace';
import type { AgentRegistryApi, AgentRegistrySnapshot } from '../shared/agent-registry';
import type { AgentManagementApi } from '../shared/agent-management';
import type { AgentChatsApi, ChatsSnapshot, ChatsUpdate, RoomMessage } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import { avatarPng } from './agent-avatar-image-fixtures';

const managementApi: AgentManagementApi = {
  engines: async () => ({ engines: [], error: null }),
  snapshot: async engineId => ({ engineId, online: false, error: null, agents: [] }),
  details: async () => { throw Error('Unexpected container inspection'); },
  control: async () => { throw Error('Unexpected container control'); },
};
const chatsApi = { request: async () => ({ rooms: [], messages: [] }) };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(element => element.getAttribute('aria-label') === label)!;

test('rail follows live tasks across rooms independently of the open Homie and historical activity', async () => {
  const first = specialistAgent(), second = { ...first, id: 'research', name: 'Research' };
  const registry = { list: async () => ({ workspaceRoot: '/project', agents: [first, second] }), onDidChange: () => () => {} };
  const message = (id: string, recipient: string | null, status: string): RoomMessage => ({
    id, roomId: id, sender: 'user', recipient, taskId: id, threadId: null,
    kind: 'message', text: 'Task', status, createdAt: '2026-10-12T00:00:00Z',
  });
  let snapshot: ChatsSnapshot = { cursor: { epoch: 'rail', sequence: 0 }, rooms: [], messages: [
    message('first-room', first.id, 'queued'), message('other-room', second.id, 'queued'),
    { ...message('old-activity', null, 'running'), sender: second.id },
  ] };
  const listeners = new Set<(update: ChatsUpdate) => void>();
  const api: AgentChatsApi = {
    request: async () => snapshot,
    onDidChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const update = async (messages: RoomMessage[]) => {
    snapshot = { ...snapshot, cursor: { epoch: 'rail', sequence: snapshot.cursor!.sequence + 1 }, messages };
    await act(async () => { for (const listener of listeners) listener({ ...snapshot, cursor: snapshot.cursor!, removedRoomIds: [], removedMessageIds: [] }); });
  };
  await withDOM(async ui => {
    const render = (selectedHomieId: string) => ui.render(<ChatsView active api={api} registry={registry}
      homiesOpen selectedHomieId={selectedHomieId} onManageHomies={() => {}} />);
    const working = (name: string) => button(`Open Homie: ${name}`).getAttribute('data-working');
    await render(first.id);
    expect(working(first.name)).toBeNull();
    expect(working(second.name)).toBeNull();
    await update(snapshot.messages.map(m => m.id === 'other-room' ? { ...m, status: 'running' } : m));
    expect(working(second.name)).toBe('true');
    expect(working(first.name)).toBeNull();
    await render(second.id);
    expect(working(second.name)).toBe('true');
    await update(snapshot.messages.map(m => m.id === 'first-room' ? { ...m, status: 'running' } : m));
    expect(working(first.name)).toBe('true');
    for (const executionStatus of ['waiting', 'completed', 'failed', 'interrupted', 'paused', 'blocked', 'cancelled', 'unknown']) {
      await update(snapshot.messages.map(m => m.id === 'other-room' ? { ...m, executionStatus } : m));
      expect(working(second.name)).toBeNull();
      expect(working(first.name)).toBe('true');
    }
    await update(snapshot.messages.map(m => m.id === 'first-room' ? { ...m, status: 'completed' } : m));
    expect(working(first.name)).toBeNull();
    await update([...snapshot.messages, { ...message('delegated', second.id, 'delivered'), sender: first.id,
      relatedTask: { agentId: second.id, taskId: 'delegated-task' }, executionStatus: 'running' }]);
    expect(working(second.name)).toBe('true');
    expect(working(first.name)).toBeNull();
  });
});

test('rail shows all registered Homies, uses display names and images, and follows registry updates', async () => {
  const agent = { ...specialistAgent(), name: 'repository-name', displayName: 'My Homie', accountId: null, assignments: [] };
  let snapshot: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [agent] };
  const listeners = new Set<(value: AgentRegistrySnapshot) => void>();
  const registry = {
    list: async () => snapshot,
    onDidChange: (listener: (value: AgentRegistrySnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const selections: (string | undefined)[] = [];
  await withDOM(async ui => {
    await ui.render(<ChatsView active api={chatsApi} registry={registry} onManageHomies={id => selections.push(id)} />);
    const icon = button('Open Homie: My Homie');
    expect(Boolean(icon)).toBe(true);
    expect(icon.textContent).toBe('');
    expect(icon.getAttribute('aria-description')).toBe('My Homie');
    expect(document.querySelectorAll('[aria-label="Manage Homies"]').length).toBe(0);
    await ui.click('Open Homie: My Homie');
    await ui.click('New Homie');
    expect(selections).toEqual([agent.id, 'new']);
    snapshot = { ...snapshot, agents: [{ ...agent, displayName: 'Renamed', avatar: {
      character: 'sprout', color: 'mint', image: avatarPng,
    } }] };
    await act(async () => { for (const listener of listeners) listener(snapshot); });
    expect(button('Open Homie: Renamed')).toBe(icon);
    expect(icon.getAttribute('aria-description')).toBe('Renamed');
    expect(icon.querySelector('img')?.getAttribute('src')).toBe(avatarPng);
    snapshot = { ...snapshot, agents: [] };
    await act(async () => { for (const listener of listeners) listener(snapshot); });
    expect(document.querySelectorAll('[aria-label="Homie selection"] button').length).toBe(0);
    expect(button('New Homie').disabled).toBe(false);
  });
});

test('bottom add action opens creation from an empty registry and returns to the new Homie after save', async () => {
  let snapshot: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [] };
  const listeners = new Set<(value: AgentRegistrySnapshot) => void>();
  const registryApi: AgentRegistryApi = {
    list: async () => snapshot, models: async () => [], onDidChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: async input => {
      const agent = { ...specialistAgent(), ...input.profile };
      snapshot = { ...snapshot, agents: [agent] };
      for (const listener of listeners) listener(snapshot);
      return { agentId: agent.id, snapshot };
    },
  };
  await withDOM(async ui => {
    await ui.render(<WorkerWorkspace view="chats" onBeforeOpenHomies={() => {}}
      api={chatsApi} registryApi={registryApi} managementApi={managementApi} />);
    await ui.click('New Homie');
    expect(document.querySelectorAll('[aria-label="Homies sidebar"] form[aria-label="Create agent"]').length).toBe(1);
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(false);
    await ui.type('Agent name', 'First Homie');
    expect(document.querySelector<HTMLButtonElement>('form[aria-label="Create agent"] button[type="submit"]')?.disabled).toBe(false);
    await ui.click('Create agent');
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(false);
    expect(document.querySelectorAll('[aria-label="Homies sidebar"] [aria-label="Agent details"]').length).toBe(1);
    expect(button('Open Homie: First Homie').getAttribute('aria-expanded')).toBe('true');
  });
});

test('saving locks rail switching and Escape until the selected Homie save completes', async () => {
  const first = specialistAgent(), second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Second' };
  const snapshot: AgentRegistrySnapshot = { workspaceRoot: '/project', agents: [first, second] };
  const saved = registryDeferred<{ agentId: string; snapshot: AgentRegistrySnapshot }>();
  const registryApi: AgentRegistryApi = {
    list: async () => snapshot, models: async () => [], onDidChange: () => () => {}, save: async () => saved.promise,
  };
  await withDOM(async ui => {
    await ui.render(<WorkerWorkspace view="chats" onBeforeOpenHomies={() => {}}
      api={chatsApi} registryApi={registryApi} managementApi={managementApi} />);
    await ui.click(`Open Homie: ${first.name}`);
    await ui.click('Save local settings');
    expect(button('Open Homie: Second').disabled).toBe(true);
    expect(button('New Homie').disabled).toBe(true);
    await ui.click('Open Homie: Second');
    const panel = document.querySelector<HTMLElement>('[aria-label="Homies sidebar"]')!;
    await act(async () => panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(panel.getAttribute('aria-hidden')).toBeNull();
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Homie display name"]')?.value).toBe(first.name);
    await act(async () => saved.resolve({ agentId: first.id, snapshot }));
    expect(button('Open Homie: Second').disabled).toBe(false);
    await ui.click('Open Homie: Second');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Homie display name"]')?.value).toBe(second.name);
  });
});
