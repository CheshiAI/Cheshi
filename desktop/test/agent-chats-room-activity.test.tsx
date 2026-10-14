import { expect, test } from 'bun:test';
import { ChatsRoomList } from '../frontend/src/features/agent-chats/ChatsRoomList';
import type { ChatsSnapshot } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';

test('room background follows current tasks and keeps its layer for the completion fade', async () => {
  await withDOM(async ui => {
    const room = { id: 'room', name: 'Working room', workspace: '/project', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [{ id: 'dev', accountId: 'account', name: 'Development' }],
      createdAt: '2026-10-03T00:00:00Z' };
    const data: ChatsSnapshot = {
      rooms: [room, { ...room, id: 'idle', name: 'Idle room' }],
      messages: [{ id: 'goal', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev',
        kind: 'goal', text: 'Build login', taskId: 'task', status: 'running', createdAt: room.createdAt }],
    };
    const render = (snapshot: ChatsSnapshot) => ui.render(<ChatsRoomList snapshot={snapshot}
      agents={[]} selectedId="idle" phase="ready" loaded refreshing={false} disabled={false}
      error={null} pinningRoomId={null} onPin={() => {}} onSelect={() => {}} onNew={() => {}}
      onRefresh={async () => {}} />);
    await render(data);
    const working = document.querySelector('button[aria-label="Working room"]')!;
    const layer = working.firstElementChild;
    expect(working.getAttribute('data-responding')).toBe('true');
    expect(layer?.getAttribute('data-active')).toBe('true');
    expect(working.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Active response');
    expect(document.querySelector('button[aria-label="Idle room"]')?.hasAttribute('data-responding')).toBe(false);

    // A historical running activity must not keep the completed task animated.
    await render({ ...data, messages: [
      { ...data.messages[0]!, executionStatus: 'completed' },
      { ...data.messages[0]!, id: 'history', sender: 'dev', kind: 'message' },
    ] });
    expect(working.hasAttribute('data-responding')).toBe(false);
    expect(working.querySelector('[role="status"]')).toBeNull();
    expect(working.firstElementChild).toBe(layer);
    expect(layer?.hasAttribute('data-active')).toBe(false);

    await render({ ...data, messages: [{ ...data.messages[0]!, sender: 'dev', taskId: undefined,
      relatedTask: { agentId: 'dev', taskId: 'related' }, executionStatus: 'running' }] });
    expect(working.getAttribute('data-responding')).toBe('true');
    expect(working.firstElementChild).toBe(layer);
  });
});
