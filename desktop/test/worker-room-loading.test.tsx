import { act, type ComponentProps } from 'react';
import { expect, test } from 'bun:test';
import type { ChatsSnapshot, ChatsUpdate, RoomMessage } from '../shared/agent-chats';
import { ChatsRoomList } from '../frontend/src/features/agent-chats/ChatsRoomList';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { withDOM } from './agent-chats-test-dom';
import { SidebarStatusContext } from '../frontend/src/shared/ui/SidebarStatusMessage';

const room = { id: 'room', workspace: '/project', name: 'Working room', engineId: 'docker:test',
  defaultAgentId: 'dev', members: [{ id: 'dev', name: 'Development', accountId: 'account' }], createdAt: '2026-10-03T00:00:00Z' };
const task: RoomMessage = { id: 'task', roomId: room.id, threadId: null, sender: 'user', recipient: 'dev',
  kind: 'goal', text: 'Build a feature', createdAt: room.createdAt, taskId: 'execution', status: 'running' };
const indicator = (name = room.name) => document.querySelector(`button[aria-label="${name}"] [role="status"][aria-label="Active response"]`);

test('empty Worker guidance appears only in the active sidebar footer and clears when rooms arrive', async () => {
  await withDOM(async ui => {
    const status = document.createElement('footer'); document.body.append(status);
    const defaults: ComponentProps<typeof ChatsRoomList> = {
      snapshot: { rooms: [], messages: [] }, agents: [], selectedId: null, phase: 'ready', loaded: true,
      refreshing: false, disabled: false, error: null, pinningRoomId: null,
      onPin() {}, onSelect() {}, onNew() {}, onRefresh: async () => {},
    };
    const render = (activePanel: string | null, overrides: Partial<typeof defaults> = {}) => ui.render(
      <SidebarStatusContext.Provider value={{ activePanel, target: status }}>
        <ChatsRoomList {...defaults} {...overrides} />
      </SidebarStatusContext.Provider>,
    );
    const message = 'create a work room and invite your homies to begin.';
    await render('agent-chats', { loaded: false, phase: 'loading' });
    expect(status.textContent).toBe('');
    expect(document.querySelector('[aria-label="Loading rooms…"]')).not.toBeNull();
    await render('agent-chats');
    expect(status.textContent).toBe(message);
    expect(status.querySelector('svg')).toBeNull();
    expect(document.querySelector('[aria-label="Worker rooms"]')?.textContent).not.toContain(message);
    expect(document.querySelector('[aria-label="New room"]')).not.toBeNull();
    for (const panel of ['canvas', 'chats', null]) {
      await render(panel);
      expect(status.textContent).toBe('');
    }
    await render('agent-chats', { phase: 'error', error: 'Room service unavailable' });
    expect(status.textContent).toBe('');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Room service unavailable');
    await render('agent-chats', { snapshot: { rooms: [room], messages: [] } });
    expect(status.textContent).toBe('');
    expect(document.querySelector(`[aria-label="${room.name}"]`)).not.toBeNull();
    await ui.type('Search rooms', 'missing');
    expect(status.textContent).toBe('');
    expect(document.querySelector('[aria-label="Worker rooms"]')?.textContent).toContain('No matching rooms.');
    await ui.type('Search rooms', '');
    await render('agent-chats');
    expect(status.textContent).toBe(message);
    await ui.render(null);
    expect(status.textContent).toBe('');
  });
});

test('room loading follows current task state and ignores historical activity and other rooms', async () => {
  await withDOM(async ui => {
    const historical: RoomMessage = { ...task, id: 'activity', sender: 'dev', kind: 'message',
      createdAt: '2026-10-04T00:00:00Z', text: 'Earlier tool execution', status: 'running' };
    const rooms = [room, { ...room, id: 'idle', name: 'Idle room' }];
    const render = (messages: RoomMessage[]) => ui.render(<ChatsRoomList snapshot={{ rooms, messages }} agents={[]}
      selectedId="idle" phase="ready" loaded refreshing={false} disabled={false} error={null} pinningRoomId={null}
      onPin={() => {}} onSelect={() => {}} onNew={() => {}} onRefresh={async () => {}} />);
    await render([historical]);
    expect(indicator()).toBeNull();
    await render([task, historical]);
    expect(indicator()).not.toBeNull();
    expect(indicator()!.parentElement?.querySelector('[data-active="true"]')).not.toBeNull();
    expect(indicator('Idle room')).toBeNull();
    for (const status of ['completed', 'failed', 'interrupted', 'paused', 'blocked', 'held', 'cancelled', 'waiting', 'unknown']) {
      await render([{ ...task, status }, historical]);
      expect(indicator()).toBeNull();
    }
    await render([{ ...task, status: 'running', executionStatus: 'completed' }, historical]);
    expect(indicator()).toBeNull();
  });
});

test('a room keeps one indicator until all direct and delegated tasks finish', async () => {
  await withDOM(async ui => {
    const delegated: RoomMessage = { ...task, id: 'delegated', sender: 'dev', recipient: 'planner', kind: 'question',
      status: 'delivered', relatedTask: { agentId: 'planner', taskId: 'planning' }, executionStatus: 'running' };
    const render = (messages: RoomMessage[]) => ui.render(<ChatsRoomList snapshot={{ rooms: [room], messages }} agents={[]}
      selectedId={room.id} phase="ready" loaded refreshing={false} disabled={false} error={null} pinningRoomId={null}
      onPin={() => {}} onSelect={() => {}} onNew={() => {}} onRefresh={async () => {}} />);
    await render([task, delegated]);
    expect(document.querySelectorAll('[aria-label="Active response"]')).toHaveLength(1);
    await render([{ ...task, status: 'completed' }, delegated]);
    expect(indicator()).not.toBeNull();
    await render([{ ...task, status: 'completed' }, { ...delegated, executionStatus: 'interrupted' }]);
    expect(indicator()).toBeNull();
  });
});

test('worker sidebar receives live execution changes while the worker page is hidden', async () => {
  await withDOM(async ui => {
    const data: ChatsSnapshot = { cursor: { epoch: 'loading', sequence: 0 }, rooms: [room], messages: [{ ...task, status: 'completed' }] };
    let receive!: (update: ChatsUpdate) => void;
    const sidebar = document.createElement('div'); document.body.append(sidebar);
    await ui.render(<ChatsView active={false} sidebarActive sidebarTarget={sidebar} api={{
      request: async () => data,
      onDidChange: listener => { receive = listener; return () => {}; },
    }} />);
    expect(indicator()).toBeNull();
    await act(async () => receive({ cursor: { epoch: 'loading', sequence: 1 }, rooms: [], messages: [task], removedRoomIds: [], removedMessageIds: [] }));
    expect(indicator()).not.toBeNull();
    await act(async () => receive({ cursor: { epoch: 'loading', sequence: 2 }, rooms: [], messages: [{ ...task, status: 'completed' }], removedRoomIds: [], removedMessageIds: [] }));
    expect(indicator()).toBeNull();
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')!.hidden).toBe(true);
  });
});
