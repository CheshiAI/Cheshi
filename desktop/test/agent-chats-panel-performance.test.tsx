import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { MAX_TIMELINE_ROWS } from '../frontend/src/features/agent-chats/roomTimelineLayout';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { AgentChatsApi, ChatsSnapshot, ChatsUpdate, RoomMessage } from '../shared/agent-chats';
import { specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

test('opening Homies and typing a draft do not reread message bodies; live updates and replies still work', async () => {
  let bodyReads = 0;
  const messages = Array.from({ length: 200 }, (_, index): RoomMessage => ({
    id: `message-${index}`, roomId: 'room', threadId: null, sender: 'user', recipient: null,
    kind: 'message', createdAt: '2026-10-06T00:00:00Z',
    get text() { if (index === 150) bodyReads++; return `Saved message ${index}`; },
  }));
  const snapshot: ChatsSnapshot = { cursor: { epoch: 'test', sequence: 0 }, rooms: [{
    id: 'room', name: 'Work', workspace: '/project', engineId: 'docker:test', defaultAgentId: 'dev',
    members: [], createdAt: '2026-10-06T00:00:00Z',
  }], messages };
  let receive: ((update: ChatsUpdate) => void) | undefined;
  const api: AgentChatsApi = { request: async () => snapshot,
    onDidChange: listener => { receive = listener; return () => { receive = undefined; }; } };
  const agent = specialistAgent();
  const registry = { list: async () => ({ workspaceRoot: '/project', agents: [agent] }), onDidChange: () => () => {} };
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ChatsView active api={api} registry={registry} selectedHomieId={agent.id} homiesOpen={open} onManageHomies={() => setOpen(value => !value)} />;
  }
  await withDOM(async ui => {
    await ui.render(<Harness />);
    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(MAX_TIMELINE_ROWS);
    const initialReads = bodyReads;
    expect(initialReads).toBeGreaterThan(0);
    const timeline = document.querySelector('[aria-label="Room messages"]');
    await ui.click(`Open Homie: ${agent.name}`);
    expect(document.querySelector(`[aria-label="Open Homie: ${agent.name}"]`)?.getAttribute('aria-expanded')).toBe('true');
    await ui.type('Message', 'Keep my draft');
    await ui.click(`Open Homie: ${agent.name}`);
    expect(bodyReads).toBe(initialReads);
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep my draft');

    await act(async () => receive?.({ cursor: { epoch: 'test', sequence: 1 }, rooms: [],
      messages: [{ ...messages[160]!, text: 'Another row changed' }], removedRoomIds: [], removedMessageIds: [] }));
    expect(bodyReads).toBe(initialReads);
    await act(async () => receive?.({ cursor: { epoch: 'test', sequence: 2 }, rooms: [],
      messages: [{ ...messages[150]!, text: 'Updated message' }], removedRoomIds: [], removedMessageIds: [] }));
    expect(document.querySelector('[data-message-id="message-150"]')?.textContent).toContain('Updated message');
    await ui.click('Reply to Updated message');
    expect(document.querySelector('[aria-label="Reply context"]')?.textContent).toContain('Updated message');
  });
});

test('multiple worker tasks show one automatic quote each while explicit replies keep their context', async () => {
  const root = (id: string): RoomMessage => ({ id, roomId: 'room', threadId: null, taskId: id,
    sender: 'user', recipient: 'dev', kind: 'message', text: `Task ${id}`, status: 'running', createdAt: '2026-10-16' });
  const first = root('first'), second = root('second');
  const progress = (id: string, source: RoomMessage): RoomMessage => ({ ...source, id, sender: 'dev',
    recipient: null, threadId: source.id, text: `Progress ${id}` });
  const snapshot: ChatsSnapshot = { rooms: [{ id: 'room', name: 'Work', workspace: '/project',
    engineId: 'docker:test', defaultAgentId: 'dev', members: [], createdAt: '2026-10-16' }],
    messages: [first, second, progress('one', first), progress('two', second), progress('three', first),
      { ...progress('four', second), text: '', activity: { id: 'command', turnId: 'turn', kind: 'command',
        title: 'capture', text: 'captured', status: 'completed', final: true, truncated: false, createdAt: '2026-10-16' } },
      { ...progress('reply', first), sender: 'user', recipient: 'dev', replyTo: first.id }] };
  const api: AgentChatsApi = { request: async () => snapshot, onDidChange: () => () => {} };
  await withDOM(async ui => {
    await ui.render(<ChatsView active api={api} />);
    expect([...document.querySelectorAll('article blockquote')].map(node => node.textContent))
      .toEqual(['You: Task first', 'You: Task second', 'You: Task first']);
    expect(document.querySelector('[data-message-id="three"] blockquote')).toBeNull();
    expect(document.querySelector('[data-message-id="four"] blockquote')).toBeNull();
    expect(document.querySelector('[data-message-id="four"]')?.textContent).toContain('Command');
    expect(document.querySelector('[data-message-id="reply"] blockquote')?.textContent).toBe('You: Task first');
  });
});
