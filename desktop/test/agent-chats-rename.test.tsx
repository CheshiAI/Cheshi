import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred as createDeferred } from './agent-registry-fixtures';

const snapshot = (): ChatsSnapshot => ({ rooms: ['first', 'second'].map(id => ({ id, workspace: '/project', name: id,
  engineId: 'docker:test', defaultAgentId: 'dev', members: [{ id: 'dev', accountId: 'account', name: 'Development' }],
  createdAt: '2026-10-03T00:00:00Z' })), messages: [] });

test('room rename preserves selected room and draft, persists through refresh and cancels without writing', async () => {
  await withDOM(async ui => {
    let data = snapshot(), opened = 0;
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => {
      requests.push(request);
      if (request.action === 'rename') data = { ...data, rooms: data.rooms.map(room => room.id === request.roomId ? { ...room, name: request.name } : room) };
      return data;
    } };
    await ui.render(<ChatsView active api={api} onOpenRoom={() => { opened++; }} />);
    await ui.type('Message', 'Keep my draft');
    await ui.click('Rename room: second');
    expect(opened).toBe(0);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Room title');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Room title"]')?.value).toBe('second');
    await ui.type('Room title', '   ');
    expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(true);
    await ui.click('Cancel');
    expect(requests.some(request => request.action === 'rename')).toBe(false);
    await ui.click('Rename room: second'); await ui.type('Room title', '  Short  '); await ui.click('Save');
    expect(requests.at(-1)).toEqual({ action: 'rename', roomId: 'second', name: 'Short' });
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('first');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep my draft');
    expect(document.querySelector('dialog')).toBeNull();
    await ui.click('Refresh rooms');
    expect(document.querySelector('[aria-label="Rename room: Short"]')).not.toBeNull();
    expect(data.rooms[1]?.members).toEqual(snapshot().rooms[1]?.members);
  });
});

test('room rename works in the sidebar without navigation and keeps failures visible for retry', async () => {
  await withDOM(async ui => {
    const target = document.createElement('div'); document.body.append(target);
    let data = snapshot(), opened = 0, attempts = 0;
    const pending = createDeferred<ChatsSnapshot>();
    const api = { request: async (request: ChatsRequest) => {
      if (request.action !== 'rename') return data;
      if (++attempts === 1) return pending.promise;
      data = { ...data, rooms: data.rooms.map(room => room.id === request.roomId ? { ...room, name: request.name } : room) };
      return data;
    } };
    await ui.render(<ChatsView active={false} sidebarActive sidebarTarget={target} api={api} onOpenRoom={() => { opened++; }} />);
    await ui.click('Rename room: first'); await ui.type('Room title', 'Short'); await ui.click('Save');
    expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(true);
    expect(target.querySelector('[aria-label="first"]')).not.toBeNull();
    await act(async () => pending.reject(new Error('Could not save title')));
    expect(document.querySelector('dialog [role="alert"]')?.textContent).toBe('Could not save title');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Room title"]')?.value).toBe('Short');
    await ui.click('Save');
    expect(target.querySelector('[aria-label="Short"]')).not.toBeNull();
    expect(opened).toBe(0); expect(attempts).toBe(2);
    expect(document.querySelector('dialog')).toBeNull();
  });
});
