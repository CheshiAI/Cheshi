import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';
const snapshot = (): ChatsSnapshot => ({ rooms: [{ id: 'room', workspace: '/project', name: 'Login', engineId: 'docker:test', defaultAgentId: 'dev',
  members: [{ id: 'dev', accountId: 'account', name: 'Development' }], createdAt: '2026-10-03T00:00:00Z' }], messages: [
  { id: 'goal', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', kind: 'goal', text: 'Build login', createdAt: '2026-10-03T00:00:00Z', taskId: 'task', status: 'waiting' },
  { id: 'reply', roomId: 'room', threadId: 'goal', sender: 'dev', recipient: null, kind: 'message', text: 'Waiting for design', createdAt: '2026-10-03T00:01:00Z', taskId: 'task', status: 'waiting' },
] });
test('room pins reorder both groups and search while preserving selection, draft and messages', async () => {
  await withDOM(async ui => {
    const initial = snapshot(), base = initial.rooms[0]!;
    let data: ChatsSnapshot = { rooms: [base, { ...base, id: 'old-pin', name: 'Login old pin', pinned: true, createdAt: '2026-10-01T00:00:00Z' },
      { ...base, id: 'new-pin', name: 'Login new pin', pinned: true, createdAt: '2026-10-02T00:00:00Z' },
      { ...base, id: 'new', name: 'Login newest', createdAt: '2026-10-04T00:00:00Z' }], messages: initial.messages };
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => {
      requests.push(request);
      if (request.action === 'pin') data = { ...data, rooms: data.rooms.map(room => room.id === request.roomId ? { ...room, pinned: request.pinned } : room) };
      return data;
    } };
    await ui.render(<ChatsView active api={api} />);
    const order = () => [...document.querySelectorAll('[aria-label="Rooms"] button[aria-current], [aria-label="Rooms"] button')]
      .map(button => button.getAttribute('aria-label')).filter(label => label?.startsWith('Login'));
    expect(order()).toEqual(['Login new pin', 'Login old pin', 'Login newest', 'Login']);
    await ui.click('Login newest');
    await ui.type('Message', 'Keep pin draft');
    const timeline = document.querySelector('[aria-label="Room messages"]');
    await ui.click('Pin room: Login');
    expect(requests.at(-1)).toEqual({ action: 'pin', roomId: 'room', pinned: true });
    expect(order()).toEqual(['Login', 'Login new pin', 'Login old pin', 'Login newest']);
    expect(document.querySelectorAll('[aria-label="Rooms"] button[aria-pressed="true"]')).toHaveLength(3);
    expect(document.querySelector('button[aria-current="page"]')?.getAttribute('aria-label')).toBe('Login newest');
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep pin draft');
    await ui.type('Search rooms', 'Login'); expect(order()).toEqual(['Login', 'Login new pin', 'Login old pin', 'Login newest']);
    await ui.type('Search rooms', 'new'); expect(order()).toEqual(['Login new pin', 'Login newest']);
    await ui.click('Clear room search'); await ui.click('Unpin room: Login');
    expect(order()).toEqual(['Login new pin', 'Login old pin', 'Login newest', 'Login']);
    expect(requests.at(-1)).toEqual({ action: 'pin', roomId: 'room', pinned: false });
  });
});
test('pin remains unconfirmed while pending and after a rejected save', async () => {
  await withDOM(async ui => {
    let rejectPin: ((error: Error) => void) | undefined;
    const api = { request: (request: ChatsRequest) => request.action === 'pin'
      ? new Promise<ChatsSnapshot>((_resolve, reject) => { rejectPin = reject; }) : Promise.resolve(snapshot()) };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Pin room: Login');
    expect(document.querySelector('[aria-label="Rooms"] button[aria-pressed="true"]')).toBeNull();
    expect((document.querySelector('[aria-label="Pin room: Login"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { rejectPin!(new Error('Pin save failed')); });
    expect(document.querySelector('[aria-label="Rooms"] button[aria-pressed="true"]')).toBeNull();
    expect(document.body.textContent).toContain('Pin save failed');
    expect((document.querySelector('[aria-label="Pin room: Login"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
