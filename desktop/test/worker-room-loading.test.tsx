import { act } from 'react';
import { expect, test } from 'bun:test';
import type { ChatsSnapshot, ChatsUpdate, RoomMessage } from '../shared/agent-chats';
import { ChatsRoomList } from '../frontend/src/features/agent-chats/ChatsRoomList';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { withDOM } from './agent-chats-test-dom';

const room = { id: 'room', workspace: '/project', name: 'Working room', engineId: 'docker:test',
  defaultAgentId: 'dev', members: [{ id: 'dev', name: 'Development', accountId: 'account' }], createdAt: '2026-10-03T00:00:00Z' };
const task: RoomMessage = { id: 'task', roomId: room.id, threadId: null, sender: 'user', recipient: 'dev',
  kind: 'goal', text: 'Build a feature', createdAt: room.createdAt, taskId: 'execution', status: 'running' };
const indicator = (name = room.name) => document.querySelector(`button[aria-label="${name}"] [role="status"][aria-label="Active response"]`);

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
    expect(indicator()!.children).toHaveLength(9);
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
